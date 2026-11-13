//! `vtb flow validate` end to end: the real binary, no Sacrum config.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vtb-flow-validate-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Run vtb with an empty HOME so a passing run proves no config is needed.
fn vtb(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_vtb"))
        .args(args)
        .env("HOME", home)
        .env_remove("XDG_CONFIG_HOME")
        .output()
        .unwrap()
}

const VALID: &str = "version: 1\nparts:\n  - {id: a, kind: source}\n  - {id: b, kind: worker}\nrails:\n  - {id: r, from: a.out, to: b.in}\n";

#[test]
fn valid_spec_exits_zero_without_config() {
    let dir = temp_dir("valid");
    let spec = dir.join("ok.flow.yaml");
    std::fs::write(&spec, VALID).unwrap();
    let out = vtb(&dir, &["flow", "validate", spec.to_str().unwrap()]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "valid yaml flow spec"
    );
}

#[test]
fn invalid_spec_prints_each_error_line_and_exits_non_zero() {
    let dir = temp_dir("invalid");
    let spec = dir.join("bad.flow.yaml");
    let bad = VALID
        .replace("kind: worker", "kind: wroker")
        .replace("{id: r,", "{id: 'bad id',");
    std::fs::write(&spec, bad).unwrap();
    let out = vtb(&dir, &["flow", "validate", spec.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    let lines: Vec<&str> = stderr.lines().collect();
    assert!(lines.len() >= 2, "{stderr}");
    assert!(
        lines.iter().any(|l| l
            .starts_with(r#"parts[1].kind: unknown part kind "wroker" (did you mean "worker"?)"#)),
        "{stderr}"
    );
    assert!(
        lines.iter().any(|l| l.starts_with("rails[0].id: ")),
        "{stderr}"
    );
}

#[test]
fn json_output_reports_errors_and_exits_non_zero() {
    let dir = temp_dir("json");
    let spec = dir.join("bad.flow.json");
    std::fs::write(&spec, r#"{"version": 1, "parts": []}"#).unwrap();
    let out = vtb(
        &dir,
        &["--json", "flow", "validate", spec.to_str().unwrap()],
    );
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["valid"], false);
    assert_eq!(report["format"], "json");
    assert_eq!(report["errors"][0]["path"], "parts");
    assert_eq!(
        report["errors"][0]["line"],
        "parts: needs at least one part"
    );
}
