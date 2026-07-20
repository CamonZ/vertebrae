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
use std::path::{Component, Path, PathBuf};

/// Substrings that would trigger Sacrum's Liquid template pass on the prompt.
/// These must not appear anywhere in the envelope JSON or its fixture lines.
const PROHIBITED_SEQUENCES: [&str; 4] = ["{{", "}}", "{%", "%}"];

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
        }
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

        let envelope = serde_json::json!({
            "exit_code": self.exit_code,
            "delay_ms": self.delay_ms,
            "stdout_file": stdout_value,
            "stderr_file": stderr_value,
        });

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
    fn check_no_prohibited_sequence_allows_plain_text() {
        assert!(check_no_prohibited_sequence("hello world { } % ok", "x").is_ok());
    }
}
