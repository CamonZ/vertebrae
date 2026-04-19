//! Per-execution Claude Code settings synthesis.
//!
//! The daemon writes a `settings.json` + bundled PreToolUse hook script to a
//! temp directory for each step execution, and passes `--settings <path>` to
//! `claude -p`. The hook denies `vtb transition-to` / `vtb workflow assign`
//! so step agents cannot advance their own tasks -- transitions are owned by
//! the workflow engine.

use std::path::{Path, PathBuf};

use serde_json::json;
use tempfile::TempDir;

const DENY_HOOK_SCRIPT: &str = include_str!("../resources/deny-self-transition.sh");
const HOOK_SCRIPT_FILENAME: &str = "deny-self-transition.sh";
const SETTINGS_FILENAME: &str = "settings.json";

/// A synthesized, per-execution Claude Code settings bundle. The temp
/// directory it owns is deleted on drop.
pub struct SyntheticSettings {
    dir: TempDir,
}

impl SyntheticSettings {
    pub fn create(execution_id: &str) -> std::io::Result<Self> {
        let dir = tempfile::Builder::new()
            .prefix(&format!("vtb-daemon-{execution_id}-"))
            .tempdir()?;

        let script_path = dir.path().join(HOOK_SCRIPT_FILENAME);
        write_executable_file(&script_path, DENY_HOOK_SCRIPT)?;

        let settings_json = build_settings_json(&script_path);
        std::fs::write(dir.path().join(SETTINGS_FILENAME), settings_json.as_bytes())?;

        Ok(Self { dir })
    }

    pub fn settings_path(&self) -> PathBuf {
        self.dir.path().join(SETTINGS_FILENAME)
    }

    pub fn dir(&self) -> &Path {
        self.dir.path()
    }
}

/// Layers two independent defenses: `permissions.deny` blocks the common
/// forms statically, and the PreToolUse hook catches wrapped/chained variants
/// (`sh -c '...'`, `foo && vtb transition-to ...`) with an actionable reason.
fn build_settings_json(hook_script: &Path) -> String {
    let settings = json!({
        "permissions": {
            "deny": [
                "Bash(vtb transition-to *)",
                "Bash(vtb workflow assign *)"
            ]
        },
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {
                            "type": "command",
                            "command": hook_script.to_string_lossy()
                        }
                    ]
                }
            ]
        }
    });
    serde_json::to_string_pretty(&settings).expect("settings JSON is always serializable")
}

fn write_executable_file(path: &Path, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, contents)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn create_writes_hook_script_and_settings_and_cleans_up_on_drop() {
        let dir_path;
        let settings_path;
        {
            let settings = SyntheticSettings::create("test-exec-create")
                .expect("should create synthetic settings");

            dir_path = settings.dir().to_path_buf();
            settings_path = settings.settings_path();

            assert!(dir_path.is_dir(), "temp dir should exist");
            assert!(settings_path.is_file(), "settings.json should exist");

            let script_path = dir_path.join(HOOK_SCRIPT_FILENAME);
            assert!(script_path.is_file(), "hook script should exist");

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&script_path)
                    .unwrap()
                    .permissions()
                    .mode();
                assert_eq!(
                    mode & 0o777,
                    0o755,
                    "hook script must be executable (owner rwx, group/other rx)"
                );
            }

            let contents = std::fs::read_to_string(&settings_path).unwrap();
            let parsed: serde_json::Value =
                serde_json::from_str(&contents).expect("settings.json must be valid JSON");

            let deny = parsed["permissions"]["deny"]
                .as_array()
                .expect("permissions.deny must be an array");
            let deny_strs: Vec<&str> = deny.iter().filter_map(|v| v.as_str()).collect();
            assert!(
                deny_strs.contains(&"Bash(vtb transition-to *)"),
                "deny list must include Bash(vtb transition-to *), got {deny_strs:?}"
            );
            assert!(
                deny_strs.contains(&"Bash(vtb workflow assign *)"),
                "deny list must include Bash(vtb workflow assign *), got {deny_strs:?}"
            );

            let hooks = &parsed["hooks"]["PreToolUse"][0];
            assert_eq!(
                hooks["matcher"].as_str(),
                Some("Bash"),
                "PreToolUse hook must match Bash tool"
            );
            let command = hooks["hooks"][0]["command"]
                .as_str()
                .expect("hook command must be a string");
            assert_eq!(
                command,
                script_path.to_string_lossy(),
                "hook command path must point at the per-execution script"
            );
            assert_eq!(
                hooks["hooks"][0]["type"].as_str(),
                Some("command"),
                "hook must be a command hook"
            );
        }

        assert!(
            !dir_path.exists(),
            "temp dir {} should have been cleaned up on drop",
            dir_path.display()
        );
        assert!(
            !settings_path.exists(),
            "settings.json should have been cleaned up on drop"
        );
    }

    #[test]
    fn create_generates_distinct_dirs_per_execution() {
        let a = SyntheticSettings::create("exec-a").expect("create a");
        let b = SyntheticSettings::create("exec-b").expect("create b");
        assert_ne!(a.dir(), b.dir(), "distinct exec ids get distinct dirs");
        assert!(
            a.dir().to_string_lossy().contains("exec-a"),
            "dir should encode the execution id: {}",
            a.dir().display()
        );
        assert!(
            b.dir().to_string_lossy().contains("exec-b"),
            "dir should encode the execution id: {}",
            b.dir().display()
        );
    }

    fn run_hook(stdin_json: &str) -> (bool, String) {
        let dir = tempfile::tempdir().unwrap();
        let script_path = dir.path().join("deny-self-transition.sh");
        write_executable_file(&script_path, DENY_HOOK_SCRIPT).unwrap();

        let mut child = Command::new("bash")
            .arg(&script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn hook script");
        {
            use std::io::Write;
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(stdin_json.as_bytes())
                .unwrap();
        }
        let output = child.wait_with_output().expect("wait hook");
        let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");

        let is_deny = stdout.contains("\"permissionDecision\": \"deny\"")
            || stdout.contains("\"permissionDecision\":\"deny\"");
        (is_deny, stdout)
    }

    #[test]
    fn hook_denies_direct_transition_to() {
        let (is_deny, out) =
            run_hook(r#"{"tool_input":{"command":"vtb transition-to 067e7809 done"}}"#);
        assert!(is_deny, "expected deny, got {out}");
        assert!(
            out.contains("workflow engine owns step transitions"),
            "denial reason must mention engine ownership, got {out}"
        );
    }

    #[test]
    fn hook_denies_workflow_assign() {
        let (is_deny, out) =
            run_hook(r#"{"tool_input":{"command":"vtb workflow assign task-abc wf-123"}}"#);
        assert!(is_deny, "expected deny, got {out}");
    }

    #[test]
    fn hook_denies_sh_c_wrapped_transition() {
        let (is_deny, out) =
            run_hook(r#"{"tool_input":{"command":"sh -c 'vtb transition-to 067e7809 done'"}}"#);
        assert!(is_deny, "expected deny for sh -c wrapped form, got {out}");
    }

    #[test]
    fn hook_denies_chained_transition() {
        let (is_deny, out) = run_hook(
            r#"{"tool_input":{"command":"echo done && vtb transition-to 067e7809 done"}}"#,
        );
        assert!(
            is_deny,
            "expected deny for chained command with &&, got {out}"
        );
    }

    #[test]
    fn hook_denies_env_var_prefixed_transition() {
        let (is_deny, out) =
            run_hook(r#"{"tool_input":{"command":"env VTB_X=1 vtb transition-to 067e7809 done"}}"#);
        assert!(is_deny, "expected deny for env-prefixed command, got {out}");
    }

    #[test]
    fn hook_allows_vtb_show() {
        let (is_deny, out) = run_hook(r#"{"tool_input":{"command":"vtb show 067e7809"}}"#);
        assert!(!is_deny, "vtb show must pass through, got {out}");
        assert!(
            out.is_empty(),
            "pass-through must produce no stdout, got {out:?}"
        );
    }

    #[test]
    fn hook_allows_vtb_list() {
        let (is_deny, _out) = run_hook(r#"{"tool_input":{"command":"vtb list --level ticket"}}"#);
        assert!(!is_deny, "vtb list must pass through");
    }

    #[test]
    fn hook_allows_vtb_section() {
        let (is_deny, _out) = run_hook(
            r#"{"tool_input":{"command":"vtb section 067e7809 constraint 'must handle X'"}}"#,
        );
        assert!(!is_deny, "vtb section must pass through");
    }

    #[test]
    fn hook_allows_word_boundary_near_miss() {
        let (is_deny, _out) =
            run_hook(r#"{"tool_input":{"command":"myvtb transition-to 067e7809 done"}}"#);
        assert!(
            !is_deny,
            "must not match when `vtb` is a substring of another identifier"
        );
    }

    #[test]
    fn hook_allows_innocuous_bash_commands() {
        let (is_deny, _out) =
            run_hook(r#"{"tool_input":{"command":"cargo test --quiet --workspace"}}"#);
        assert!(!is_deny, "unrelated commands must pass through");

        let (is_deny, _out) = run_hook(r#"{"tool_input":{"command":"ls -la"}}"#);
        assert!(!is_deny, "ls must pass through");
    }
}
