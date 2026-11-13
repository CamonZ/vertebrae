//! `vtb flow validate`: check a machine-diagram flow spec offline.
//!
//! The parser, validator and compiler are the GUI's TypeScript, bundled by
//! `npm run build:flow-validator` (crates/gui) into `assets/flow-validator.js`
//! and run here in an embedded QuickJS engine, so the CLI reports exactly the
//! diagnostics the chat viewer would, as `formatFlowError` lines, without Node
//! or a Sacrum connection.

use clap::{Args, Subcommand};
use rquickjs::{CatchResultExt, Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::io::Read;
use std::path::PathBuf;
use vertebrae_core::ServiceError;

/// Generated; rebuild with `npm run build:flow-validator` in crates/gui.
const VALIDATOR_BUNDLE: &str = include_str!("../../assets/flow-validator.js");
const VALIDATOR_GLOBAL: &str = "vtbValidateFlow";
const MEMORY_LIMIT_BYTES: usize = 256 * 1024 * 1024;
const STACK_LIMIT_BYTES: usize = 4 * 1024 * 1024;

/// Machine-diagram flow spec commands
#[derive(Debug, Subcommand)]
pub enum FlowCommand {
    /// Validate a flow spec (YAML or JSON) with the viewer's compiler
    ///
    /// Prints one `path: message` line per error and exits non-zero when the
    /// spec is invalid. Needs no project or backend.
    Validate(FlowValidateCommand),
}

#[derive(Debug, Args)]
pub struct FlowValidateCommand {
    /// Spec file to validate (the body of a `flow` fence), or `-` for stdin
    pub file: PathBuf,
}

/// One diagnostic, as the TypeScript `FlowSpecError` plus its formatted line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FlowError {
    /// Spec path such as `story[2].steps[0].verb`; empty for the document root.
    pub path: String,
    pub message: String,
    /// Registered names the value could have been.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<Vec<String>>,
    /// `formatFlowError` output: `path: message`, or the message at the root.
    pub line: String,
}

/// Outcome of validating one spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FlowValidation {
    #[serde(rename(deserialize = "ok"))]
    pub valid: bool,
    /// `yaml` or `json` once the text parsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    pub errors: Vec<FlowError>,
}

impl fmt::Display for FlowValidation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.valid {
            let format = self.format.as_deref().unwrap_or("flow");
            return write!(f, "valid {format} flow spec");
        }
        let lines: Vec<&str> = self.errors.iter().map(|e| e.line.as_str()).collect();
        write!(f, "{}", lines.join("\n"))
    }
}

impl FlowValidation {
    /// An invalid spec as an error carrying every diagnostic line.
    pub fn into_result(self) -> Result<Self, ServiceError> {
        if self.valid {
            Ok(self)
        } else {
            Err(ServiceError::validation_failed(format!(
                "invalid flow spec\n{self}"
            )))
        }
    }
}

impl FlowCommand {
    /// Validate and report. `Ok` carries invalid specs too; `Err` is reserved
    /// for unreadable input or an engine failure.
    pub fn execute(&self) -> Result<FlowValidation, ServiceError> {
        match self {
            FlowCommand::Validate(cmd) => cmd.execute(),
        }
    }
}

impl FlowValidateCommand {
    pub fn execute(&self) -> Result<FlowValidation, ServiceError> {
        validate_flow_source(&self.read_source()?)
    }

    fn read_source(&self) -> Result<String, ServiceError> {
        if self.file.as_os_str() == "-" {
            let mut source = String::new();
            std::io::stdin()
                .read_to_string(&mut source)
                .map_err(|e| ServiceError::invalid_input(format!("cannot read stdin: {e}")))?;
            return Ok(source);
        }
        std::fs::read_to_string(&self.file).map_err(|e| {
            ServiceError::invalid_input(format!("cannot read {}: {e}", self.file.display()))
        })
    }
}

/// Run the embedded viewer compiler over a spec body.
pub fn validate_flow_source(source: &str) -> Result<FlowValidation, ServiceError> {
    let engine = |e: String| ServiceError::validation_failed(format!("flow validator: {e}"));
    let runtime = Runtime::new().map_err(|e| engine(e.to_string()))?;
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(STACK_LIMIT_BYTES);
    let context = Context::full(&runtime).map_err(|e| engine(e.to_string()))?;
    let json = context.with(|ctx| -> Result<String, String> {
        ctx.eval::<(), _>(VALIDATOR_BUNDLE)
            .catch(&ctx)
            .map_err(|e| e.to_string())?;
        let validate: Function = ctx
            .globals()
            .get(VALIDATOR_GLOBAL)
            .catch(&ctx)
            .map_err(|e| e.to_string())?;
        validate
            .call::<_, String>((source,))
            .catch(&ctx)
            .map_err(|e| e.to_string())
    });
    let json = json.map_err(engine)?;
    serde_json::from_str(&json).map_err(|e| engine(format!("unexpected result: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = "version: 1\nparts:\n  - {id: a, kind: source}\n  - {id: b, kind: worker}\nrails:\n  - {id: r, from: a.out, to: b.in}\n";

    #[test]
    fn valid_spec_passes() {
        let result = validate_flow_source(VALID).unwrap();
        assert!(result.valid, "{result:?}");
        assert_eq!(result.format.as_deref(), Some("yaml"));
        assert!(result.errors.is_empty());
        assert_eq!(result.to_string(), "valid yaml flow spec");
    }

    #[test]
    fn json_spec_passes() {
        let json = r#"{"version": 1, "parts": [{"id": "a", "kind": "source"}]}"#;
        let result = validate_flow_source(json).unwrap();
        assert!(result.valid, "{result:?}");
        assert_eq!(result.format.as_deref(), Some("json"));
    }

    #[test]
    fn compile_errors_are_reported_as_format_flow_error_lines() {
        let result = validate_flow_source(&VALID.replace("kind: worker", "kind: wroker")).unwrap();
        assert!(!result.valid);
        let first = &result.errors[0];
        assert_eq!(first.path, "parts[1].kind");
        assert!(
            first.line.starts_with(
                r#"parts[1].kind: unknown part kind "wroker" (did you mean "worker"?)"#
            ),
            "{}",
            first.line
        );
        assert!(first.expected.as_ref().unwrap().contains(&"worker".into()));
        assert_eq!(result.to_string().lines().next(), Some(first.line.as_str()));
    }

    #[test]
    fn reference_errors_beyond_the_json_schema_are_reported() {
        let result = validate_flow_source(&VALID.replace("to: b.in", "to: b.nowhere")).unwrap();
        assert!(!result.valid);
        assert!(
            result.errors.iter().any(|e| e.path == "rails[0].to"),
            "{:?}",
            result.errors
        );
    }

    /// Options A and B over today's machine: x, y, z in A; only y and z in B, wired differently.
    const OPTIONS: &str = "version: 1
arrangements: [current, A, B]
parts:
  - {id: src, kind: source}
  - {id: w, kind: worker}
  - {id: x, kind: rate limiter, in: [A]}
  - {id: y, kind: queue, in: [A, B]}
  - {id: z, kind: store, in: [A, B]}
rails:
  - {id: direct, from: src.out, to: w.in, in: [current]}
  - {id: sx, from: src.out, to: x.in}
  - {id: xy, from: x.out, to: y.in}
  - {id: sy, from: src.out, to: y.in, in: [B]}
  - {id: yzDead, from: y.dead, to: z.in, in: [A]}
  - {id: yzOut, from: y.out, to: z.in, in: [B]}
cards:
  - {id: c, token: request, origin: src}
story:
  - caption: {current: straight in, A: limited, B: queued}
    steps:
      - {verb: send, part: src, card: c}
      - {verb: stage, part: w, card: c, via: direct}
      - {verb: send, part: x, card: c, via: sx}
      - {verb: send, part: y, card: c, via: xy}
      - {verb: send, part: y, card: c, via: sy}
";

    #[test]
    fn named_arrangements_pass() {
        let result = validate_flow_source(OPTIONS).unwrap();
        assert!(result.valid, "{result:?}");
    }

    #[test]
    fn named_arrangement_errors_name_the_arrangement() {
        let broken = OPTIONS
            .replace(
                "kind: rate limiter, in: [A]",
                "kind: rate limiter, in: [A, C]",
            )
            .replace(
                "{verb: send, part: x, card: c, via: sx}",
                "{verb: send, part: x, card: c, via: sx, in: [B]}",
            )
            .replace("A: limited", "D: limited");
        let result = validate_flow_source(&broken).unwrap();
        assert!(!result.valid);
        let lines: Vec<&str> = result.errors.iter().map(|e| e.line.as_str()).collect();
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with(r#"parts[2].in[1]: unknown arrangement "C""#)),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|l| l
                    .starts_with(r#"story[0].caption.D: caption names unknown arrangement "D""#)),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.starts_with(
                r#"story[0].steps[2].in: lists arrangement "B", where its part "x" is absent"#
            )),
            "{lines:?}"
        );
    }

    #[test]
    fn a_missing_baseline_is_reported() {
        let result = validate_flow_source(&OPTIONS.replace(
            "arrangements: [current, A, B]",
            "arrangements: [current, A, B]\nbaseline: before",
        ))
        .unwrap();
        assert!(!result.valid);
        assert_eq!(result.errors[0].path, "baseline");
        assert!(
            result.errors[0]
                .line
                .contains(r#"baseline names missing arrangement "before""#),
            "{}",
            result.errors[0].line
        );
    }

    #[test]
    fn shorthand_marks_beside_named_arrangements_are_rejected() {
        let result = validate_flow_source(&OPTIONS.replace(
            "{id: w, kind: worker}",
            "{id: w, kind: worker, change: added}",
        ))
        .unwrap();
        assert!(!result.valid);
        assert_eq!(result.errors[0].path, "parts[1].change");
    }

    #[test]
    fn unparseable_text_is_reported_at_the_root() {
        let result = validate_flow_source("parts: [a").unwrap();
        assert!(!result.valid);
        assert_eq!(result.format, None);
        assert_eq!(result.errors[0].path, "");
        assert!(result.errors[0].line.starts_with("invalid YAML at line"));
    }

    #[test]
    fn json_output_uses_valid_not_ok() {
        let result = validate_flow_source(VALID).unwrap();
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["valid"], true);
        assert!(value.get("ok").is_none());
    }

    #[test]
    fn missing_file_is_an_input_error() {
        let cmd = FlowValidateCommand {
            file: PathBuf::from("/nonexistent/flow.yaml"),
        };
        assert!(cmd.execute().is_err());
    }
}
