//! MockResponse: builder that produces the prompt-as-JSON envelope read by the
//! daemon acceptance provider mocks.
//!
//! Scenarios call `MockResponse::new(...).with_stdout_lines(...).build()` to
//! materialise the per-scenario stdout/stderr fixture files under
//! `MOCK_OUTPUT_DIR` and obtain the envelope JSON that must be used verbatim
//! as `step.prompt`.
//!
//! # Liquid template validation
//!
//! Sacrum runs a Liquid template pass over `payload.prompt` on its way to the
//! daemon. The triggers are the substrings `{{`, `}}`, `{%`, and `%}`. JSON
//! nesting produces bare `{` / `}` which are harmless — only the doubled/
//! percent forms mangle the prompt. The builder rejects any envelope whose
//! string fields or fixture lines contain a trigger so tests fail fast instead
//! of exhibiting baffling runtime behaviour.

use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Component, Path, PathBuf};

/// Substrings that would trigger Sacrum's Liquid template pass on the prompt.
/// These must not appear anywhere in the envelope JSON or its fixture lines.
const PROHIBITED_SEQUENCES: [&str; 4] = ["{{", "}}", "{%", "%}"];

/// Key of the stdout fixture line written by [`MockResponse::with_stdout_pause`].
const PAUSE_DIRECTIVE: &str = "mock_pause_ms";

/// Returns the envelope a mock plays for this delivery of `raw`. A provider
/// receives the same step prompt every time the step runs, so an envelope
/// built with [`MockResponse::followed_by`] names the next delivery's envelope
/// in `next_file`; the last one repeats. Deliveries are counted under
/// `state_dir` (the scenario's `MOCK_CAPTURE_DIR`); without one every
/// delivery plays `raw`.
pub fn scripted_turn(raw: &str, output_dir: &Path, state_dir: Option<&Path>) -> String {
    let Some(state_dir) = state_dir else {
        return raw.to_string();
    };
    let mut hasher = DefaultHasher::new();
    raw.hash(&mut hasher);
    let counter = state_dir
        .join("turns")
        .join(format!("{:016x}", hasher.finish()));
    let delivered = fs::read_to_string(&counter)
        .ok()
        .and_then(|count| count.trim().parse::<usize>().ok())
        .unwrap_or(0);
    fs::create_dir_all(counter.parent().expect("counter has a parent")).expect("create turns dir");
    fs::write(&counter, (delivered + 1).to_string()).expect("write turn counter");

    let mut envelope = raw.to_string();
    for _ in 0..delivered {
        let next = serde_json::from_str::<serde_json::Value>(&envelope)
            .ok()
            .and_then(|value| value.get("next_file")?.as_str().map(str::to_owned));
        let Some(next) = next else { break };
        validate_relative_path(&next).expect("next_file is a relative fixture path");
        envelope = fs::read_to_string(output_dir.join(&next))
            .unwrap_or_else(|error| panic!("read next envelope {next}: {error}"));
    }
    envelope
}

/// Records that the provider no longer has conversation `id`, so a later
/// resume or fork of it is rejected.
pub fn forget_session(state_dir: &Path, id: &str) {
    let dir = state_dir.join("forgotten_sessions");
    fs::create_dir_all(&dir).expect("create forgotten_sessions dir");
    fs::write(dir.join(session_file_name(id)), id).expect("record forgotten session");
}

/// Whether [`forget_session`] recorded conversation `id`.
pub fn is_forgotten_session(state_dir: &Path, id: &str) -> bool {
    state_dir
        .join("forgotten_sessions")
        .join(session_file_name(id))
        .exists()
}

fn session_file_name(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// The pause duration when `line` is a pause directive, otherwise `None`.
pub fn stdout_pause_ms(line: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object.get(PAUSE_DIRECTIVE)?.as_u64()
}

#[derive(Debug, thiserror::Error)]
pub enum MockResponseError {
    #[error("prohibited Liquid trigger {sequence:?} found in {field}")]
    LiquidTrigger {
        sequence: &'static str,
        field: String,
    },
    #[error("path {path:?} is absolute; fixture paths must be relative to MOCK_OUTPUT_DIR")]
    AbsolutePath { path: String },
    #[error("path {path:?} contains a '..' component")]
    ParentDirTraversal { path: String },
    #[error("path {path:?} is empty")]
    EmptyPath { path: String },
    #[error("failed to write fixture {path}: {source}")]
    WriteFailed {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Builder for the provider mock prompt envelope.
///
/// See the crate-level docs for the schema the mock enforces.
#[derive(Debug, Clone)]
pub struct MockResponse {
    output_dir: PathBuf,
    exit_code: i32,
    delay_ms: u64,
    stem: String,
    stdout_rel: Option<String>,
    stderr_rel: Option<String>,
    stdout_lines: Vec<String>,
    stderr_lines: Vec<String>,
    discard_session: bool,
    next: Option<Box<MockResponse>>,
}

impl MockResponse {
    /// Fixtures are named `<feature>__<scenario>__<step>.{stdout,stderr}.jsonl`
    /// so scenarios cannot reuse each other's fixtures (constraint #5).
    pub fn new(output_dir: impl Into<PathBuf>, feature: &str, scenario: &str, step: &str) -> Self {
        Self {
            output_dir: output_dir.into(),
            exit_code: 0,
            delay_ms: 0,
            stem: format!("{feature}__{scenario}__{step}"),
            stdout_rel: None,
            stderr_rel: None,
            stdout_lines: Vec::new(),
            stderr_lines: Vec::new(),
            discard_session: false,
            next: None,
        }
    }

    /// The provider forgets this turn's conversation once the turn ends, so
    /// a later resume or fork of it is rejected as an unknown id.
    pub fn with_discarded_session(mut self) -> Self {
        self.discard_session = true;
        self
    }

    /// The next delivery of this envelope plays `next` (see
    /// [`scripted_turn`]). `next` needs its own step label so its fixtures
    /// do not overwrite these.
    pub fn followed_by(mut self, next: MockResponse) -> Self {
        self.next = Some(Box::new(next));
        self
    }

    pub fn with_exit_code(mut self, code: i32) -> Self {
        self.exit_code = code;
        self
    }

    pub fn with_delay_ms(mut self, delay_ms: u64) -> Self {
        self.delay_ms = delay_ms;
        self
    }

    pub fn with_stdout_line(mut self, line: impl Into<String>) -> Self {
        if self.stdout_rel.is_none() {
            self.stdout_rel = Some(format!("{}.stdout.jsonl", self.stem));
        }
        self.stdout_lines.push(line.into());
        self
    }

    /// Pause the mock's stdout stream for `ms` milliseconds at this point, so
    /// a scenario can observe partially streamed output. The mocks consume the
    /// directive line and never emit it.
    pub fn with_stdout_pause(self, ms: u64) -> Self {
        self.with_stdout_line(format!(r#"{{"{PAUSE_DIRECTIVE}":{ms}}}"#))
    }

    pub fn with_stderr_line(mut self, line: impl Into<String>) -> Self {
        if self.stderr_rel.is_none() {
            self.stderr_rel = Some(format!("{}.stderr.jsonl", self.stem));
        }
        self.stderr_lines.push(line.into());
        self
    }

    /// Build the JSON envelope string, writing the fixture files to disk.
    ///
    /// The returned string is intended to be used verbatim as the step's
    /// `prompt`. Callers must not further interpolate it.
    pub fn build(self) -> Result<String, MockResponseError> {
        if let Some(path) = &self.stdout_rel {
            validate_relative_path(path)?;
            check_no_prohibited_sequence(path, "stdout_file")?;
        }
        if let Some(path) = &self.stderr_rel {
            validate_relative_path(path)?;
            check_no_prohibited_sequence(path, "stderr_file")?;
        }
        for (idx, line) in self.stdout_lines.iter().enumerate() {
            check_no_prohibited_sequence(line, &format!("stdout_line[{idx}]"))?;
        }
        for (idx, line) in self.stderr_lines.iter().enumerate() {
            check_no_prohibited_sequence(line, &format!("stderr_line[{idx}]"))?;
        }

        if let Some(rel) = &self.stdout_rel {
            write_fixture(&self.output_dir, rel, &self.stdout_lines)?;
        }
        if let Some(rel) = &self.stderr_rel {
            write_fixture(&self.output_dir, rel, &self.stderr_lines)?;
        }

        let stdout_value = self
            .stdout_rel
            .as_ref()
            .map(|s| serde_json::Value::String(s.clone()))
            .unwrap_or(serde_json::Value::Null);
        let stderr_value = self
            .stderr_rel
            .as_ref()
            .map(|s| serde_json::Value::String(s.clone()))
            .unwrap_or(serde_json::Value::Null);

        let mut envelope = serde_json::json!({
            "exit_code": self.exit_code,
            "delay_ms": self.delay_ms,
            "stdout_file": stdout_value,
            "stderr_file": stderr_value,
        });
        if self.discard_session {
            envelope["discard_session"] = serde_json::Value::Bool(true);
        }
        if let Some(next) = self.next {
            let next_rel = format!("{}.next.json", self.stem);
            validate_relative_path(&next_rel)?;
            check_no_prohibited_sequence(&next_rel, "next_file")?;
            let output_dir = self.output_dir.clone();
            let next_envelope = next.build()?;
            write_fixture(&output_dir, &next_rel, &[next_envelope])?;
            envelope["next_file"] = serde_json::Value::String(next_rel);
        }

        Ok(serde_json::to_string(&envelope).expect("envelope serialises"))
    }
}

fn write_fixture(dir: &Path, rel: &str, lines: &[String]) -> Result<(), MockResponseError> {
    let full = dir.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|source| MockResponseError::WriteFailed {
            path: full.clone(),
            source,
        })?;
    }
    let mut body = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
    for line in lines {
        body.push_str(line);
        body.push('\n');
    }
    fs::write(&full, body).map_err(|source| MockResponseError::WriteFailed {
        path: full.clone(),
        source,
    })?;
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), MockResponseError> {
    if path.is_empty() {
        return Err(MockResponseError::EmptyPath {
            path: path.to_string(),
        });
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(MockResponseError::AbsolutePath {
            path: path.to_string(),
        });
    }
    for component in candidate.components() {
        match component {
            Component::ParentDir => {
                return Err(MockResponseError::ParentDirTraversal {
                    path: path.to_string(),
                });
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(MockResponseError::AbsolutePath {
                    path: path.to_string(),
                });
            }
            Component::CurDir | Component::Normal(_) => {}
        }
    }
    Ok(())
}

fn check_no_prohibited_sequence(value: &str, field: &str) -> Result<(), MockResponseError> {
    for seq in PROHIBITED_SEQUENCES {
        if value.contains(seq) {
            return Err(MockResponseError::LiquidTrigger {
                sequence: seq,
                field: field.to_string(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("daemon-acc-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn builds_envelope_and_writes_stdout_fixture() {
        let dir = tmp_dir();
        let result = MockResponse::new(&dir, "feat", "scenario_one", "step_1")
            .with_exit_code(0)
            .with_stdout_line(r#"{"type":"result","result":"ok"}"#)
            .build()
            .expect("envelope builds");

        let value: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(value["exit_code"], serde_json::json!(0));
        assert_eq!(value["delay_ms"], serde_json::json!(0));
        let stdout_file = value["stdout_file"].as_str().expect("stdout_file set");
        assert_eq!(
            stdout_file, "feat__scenario_one__step_1.stdout.jsonl",
            "expected deterministic per-scenario fixture name"
        );
        assert!(value["stderr_file"].is_null(), "no stderr line -> null");

        let fixture = std::fs::read_to_string(dir.join(stdout_file)).unwrap();
        assert_eq!(fixture, "{\"type\":\"result\",\"result\":\"ok\"}\n");
    }

    #[test]
    fn no_stdout_lines_means_null_stdout_file_and_no_fixture() {
        let dir = tmp_dir();
        let result = MockResponse::new(&dir, "f", "s", "step")
            .with_exit_code(1)
            .build()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(value["stdout_file"].is_null());
        assert_eq!(value["exit_code"], serde_json::json!(1));
        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(entries.len(), 0, "no fixtures should be written");
    }

    #[test]
    fn rejects_absolute_stdout_path() {
        let dir = tmp_dir();
        let mut mr = MockResponse::new(&dir, "f", "s", "step");
        mr.stdout_rel = Some("/etc/passwd".to_string());
        let err = mr.build().unwrap_err();
        assert!(matches!(err, MockResponseError::AbsolutePath { .. }));
    }

    #[test]
    fn rejects_parent_traversal_path() {
        let dir = tmp_dir();
        let mut mr = MockResponse::new(&dir, "f", "s", "step");
        mr.stdout_rel = Some("../outside.jsonl".to_string());
        let err = mr.build().unwrap_err();
        assert!(matches!(err, MockResponseError::ParentDirTraversal { .. }));
    }

    #[test]
    fn rejects_double_open_brace_liquid_trigger_in_line() {
        let dir = tmp_dir();
        let err = MockResponse::new(&dir, "f", "s", "step")
            .with_stdout_line(r#"{"text":"hello {{ name }}"}"#)
            .build()
            .unwrap_err();
        match err {
            MockResponseError::LiquidTrigger { sequence, field } => {
                assert_eq!(sequence, "{{");
                assert!(field.starts_with("stdout_line"));
            }
            other => panic!("expected LiquidTrigger, got {other:?}"),
        }
    }

    #[test]
    fn rejects_double_close_brace_trigger() {
        let dir = tmp_dir();
        let err = MockResponse::new(&dir, "f", "s", "step")
            .with_stdout_line(r#"{"text":"hello }}"}"#)
            .build()
            .unwrap_err();
        assert!(matches!(
            err,
            MockResponseError::LiquidTrigger { sequence: "}}", .. }
        ));
    }

    #[test]
    fn rejects_percent_open_trigger() {
        let dir = tmp_dir();
        let err = MockResponse::new(&dir, "f", "s", "step")
            .with_stdout_line(r#"{% if user %}"#)
            .build()
            .unwrap_err();
        assert!(matches!(
            err,
            MockResponseError::LiquidTrigger { sequence: "{%", .. }
        ));
    }

    #[test]
    fn rejects_percent_close_trigger() {
        let dir = tmp_dir();
        let err = MockResponse::new(&dir, "f", "s", "step")
            .with_stdout_line("hello %} world")
            .build()
            .unwrap_err();
        assert!(matches!(
            err,
            MockResponseError::LiquidTrigger { sequence: "%}", .. }
        ));
    }

    #[test]
    fn bare_single_braces_from_json_nesting_are_accepted() {
        let dir = tmp_dir();
        // Typical nested JSON: `{"usage":{"input_tokens":1}}` — contains `}}`
        // at the tail. That IS a Liquid trigger, so even legitimate JSON needs
        // spacing in fixtures. Verify the single-brace variant is fine.
        let envelope = MockResponse::new(&dir, "f", "s", "step")
            .with_stdout_line(r#"{"type":"result","nested":{"k":"v"}}"#)
            .build();
        // The trailing `}}` is a trigger — ensure we flag it to keep fixtures safe.
        assert!(matches!(
            envelope,
            Err(MockResponseError::LiquidTrigger { sequence: "}}", .. })
        ));

        // Rewriting with a space between braces is accepted.
        let ok = MockResponse::new(&dir, "f", "s", "step2")
            .with_stdout_line(r#"{"type":"result","nested":{"k":"v"} }"#)
            .build();
        assert!(ok.is_ok(), "expected single-brace variant to be accepted");
    }

    #[test]
    fn stdout_pause_writes_a_directive_line_the_mocks_recognise() {
        let dir = tmp_dir();
        let envelope_str = MockResponse::new(&dir, "feat", "pause", "step_1")
            .with_stdout_line(r#"{"type":"first"}"#)
            .with_stdout_pause(1500)
            .build()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&envelope_str).unwrap();
        let written =
            std::fs::read_to_string(dir.join(value["stdout_file"].as_str().unwrap())).unwrap();
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(stdout_pause_ms(lines[0]), None);
        assert_eq!(stdout_pause_ms(lines[1]), Some(1500));
    }

    #[test]
    fn stdout_pause_ms_ignores_lines_that_only_mention_the_key() {
        assert_eq!(stdout_pause_ms("not json"), None);
        assert_eq!(stdout_pause_ms(r#"{"mock_pause_ms":"10"}"#), None);
        assert_eq!(
            stdout_pause_ms(r#"{"mock_pause_ms":10,"type":"result"}"#),
            None
        );
    }

    #[test]
    fn stderr_line_materialises_stderr_fixture() {
        let dir = tmp_dir();
        let envelope_str = MockResponse::new(&dir, "feat", "fail", "step_1")
            .with_exit_code(2)
            .with_stderr_line("boom")
            .build()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&envelope_str).unwrap();
        assert_eq!(value["exit_code"], serde_json::json!(2));
        let stderr_file = value["stderr_file"].as_str().unwrap();
        assert!(stderr_file.ends_with(".stderr.jsonl"));
        let written = std::fs::read_to_string(dir.join(stderr_file)).unwrap();
        assert_eq!(written, "boom\n");
    }

    #[test]
    fn check_no_prohibited_sequence_detects_all_four_triggers() {
        for trigger in ["{{", "}}", "{%", "%}"] {
            let err =
                check_no_prohibited_sequence(&format!("abc {trigger} def"), "input").unwrap_err();
            match err {
                MockResponseError::LiquidTrigger { sequence, field } => {
                    assert_eq!(sequence, trigger);
                    assert_eq!(field, "input");
                }
                other => panic!("expected LiquidTrigger for {trigger:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn followed_by_scripts_later_deliveries_and_repeats_the_last() {
        let dir = tmp_dir();
        let state = tmp_dir();
        let envelope = MockResponse::new(&dir, "feat", "seq", "first")
            .with_stdout_line(r#"{"turn":1}"#)
            .followed_by(
                MockResponse::new(&dir, "feat", "seq", "second")
                    .with_stdout_line(r#"{"turn":2}"#)
                    .with_discarded_session(),
            )
            .build()
            .unwrap();
        assert!(!envelope.contains("}}"), "{envelope}");
        let stdout_of = |raw: &str| {
            let value: serde_json::Value = serde_json::from_str(raw).unwrap();
            value["stdout_file"].as_str().unwrap().to_string()
        };
        let first = scripted_turn(&envelope, &dir, Some(&state));
        let second = scripted_turn(&envelope, &dir, Some(&state));
        let third = scripted_turn(&envelope, &dir, Some(&state));
        assert_eq!(stdout_of(&first), "feat__seq__first.stdout.jsonl");
        assert_eq!(stdout_of(&second), "feat__seq__second.stdout.jsonl");
        assert_eq!(third, second);
        let second: serde_json::Value = serde_json::from_str(&second).unwrap();
        assert_eq!(second["discard_session"], true);
        assert_eq!(scripted_turn(&envelope, &dir, None), envelope);
    }

    #[test]
    fn forgotten_sessions_are_recorded_per_id() {
        let state = tmp_dir();
        assert!(!is_forgotten_session(&state, "sess/1"));
        forget_session(&state, "sess/1");
        assert!(is_forgotten_session(&state, "sess/1"));
        assert!(!is_forgotten_session(&state, "sess-2"));
    }

    #[test]
    fn check_no_prohibited_sequence_allows_plain_text() {
        assert!(check_no_prohibited_sequence("hello world { } % ok", "x").is_ok());
    }
}
