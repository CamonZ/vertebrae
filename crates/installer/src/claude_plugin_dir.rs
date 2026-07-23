//! Claude Code compatibility resolution for Vertebrae-installed skills.
//!
//! Claude discovers the provider-neutral `data_dir()/skills` bundle when its
//! parent app-data root is supplied through `--plugin-dir`. Both GUI local chat
//! and daemon one-shot execution use this resolver so path validation, version
//! gating, and fallback guidance cannot drift.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use semver::Version;

const CLAUDE_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MINIMUM_CLAUDE_VERSION: Version = Version::new(2, 0, 25);

/// Result of checking whether Vertebrae's managed skill bundle can be exposed
/// to a particular Claude Code process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudePluginDirResolution {
    /// Absolute app-data root to pass as `--plugin-dir`, when compatible.
    pub plugin_root: Option<PathBuf>,
    /// Compatibility warning explaining why injection was skipped.
    pub warning: Option<String>,
}

/// Resolve the installer-owned Claude plugin root for a specific binary.
///
/// The version probe runs the same resolved binary with `--version`, inherits
/// the caller-provided PATH, and is bounded so a broken CLI cannot stall GUI
/// session startup or daemon step execution.
pub fn resolve_claude_plugin_dir(
    claude_binary: &Path,
    working_dir: &Path,
    augmented_path: &str,
) -> ClaudePluginDirResolution {
    let data_root = crate::data_dir().map_err(|error| error.to_string());
    let installed_skills = crate::installed_skills_dir().map_err(|error| error.to_string());
    let installed_skills_is_dir = installed_skills
        .as_ref()
        .is_ok_and(|installed_skills| installed_skills.is_dir());

    resolve_claude_plugin_dir_with_probe(
        data_root,
        installed_skills,
        installed_skills_is_dir,
        working_dir,
        || query_claude_version(claude_binary, augmented_path),
    )
}

/// Resolve the path contract before invoking the version probe.
///
/// Keeping the probe behind a closure is intentional: invalid installer paths
/// can produce a useful diagnostic without spawning an unrelated Claude
/// process. The closure is invoked exactly once only after all path checks
/// succeed.
fn resolve_claude_plugin_dir_with_probe(
    data_root: Result<PathBuf, String>,
    installed_skills: Result<PathBuf, String>,
    installed_skills_is_dir: bool,
    working_dir: &Path,
    probe: impl FnOnce() -> Result<String, String>,
) -> ClaudePluginDirResolution {
    let (data_root, installed_skills) = match validate_plugin_paths(
        data_root,
        installed_skills,
        installed_skills_is_dir,
        working_dir,
    ) {
        Ok(paths) => paths,
        Err(resolution) => return resolution,
    };

    resolve_claude_plugin_dir_for_validated_paths(data_root, installed_skills, probe(), working_dir)
}

fn query_claude_version(claude_binary: &Path, augmented_path: &str) -> Result<String, String> {
    query_claude_version_with_timeout(claude_binary, augmented_path, CLAUDE_VERSION_TIMEOUT)
}

fn query_claude_version_with_timeout(
    claude_binary: &Path,
    augmented_path: &str,
    timeout: Duration,
) -> Result<String, String> {
    let mut child = Command::new(claude_binary)
        .arg("--version")
        .env("PATH", augmented_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "could not run '{} --version': {error}",
                claude_binary.display()
            )
        })?;

    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "'{} --version' timed out after {} seconds",
                    claude_binary.display(),
                    timeout.as_secs_f32()
                ));
            }
            Ok(None) => {
                let remaining = timeout.saturating_sub(started_at.elapsed());
                thread::sleep(VERSION_POLL_INTERVAL.min(remaining));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "could not wait for '{} --version': {error}",
                    claude_binary.display()
                ));
            }
        }
    }

    let output = child.wait_with_output().map_err(|error| {
        format!(
            "could not collect output from '{} --version': {error}",
            claude_binary.display()
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        let detail = if stderr.is_empty() {
            String::new()
        } else {
            format!(": {}", sanitize_detail(stderr))
        };
        return Err(format!(
            "'{} --version' exited with {}{}",
            claude_binary.display(),
            output.status,
            detail
        ));
    }

    String::from_utf8(output.stdout)
        .map_err(|error| format!("Claude Code version output was not UTF-8: {error}"))
}

#[cfg(test)]
fn resolve_claude_plugin_dir_from_checks(
    data_root: Result<PathBuf, String>,
    installed_skills: Result<PathBuf, String>,
    installed_skills_is_dir: bool,
    version_output: Result<String, String>,
    working_dir: &Path,
) -> ClaudePluginDirResolution {
    resolve_claude_plugin_dir_with_probe(
        data_root,
        installed_skills,
        installed_skills_is_dir,
        working_dir,
        || version_output,
    )
}

fn validate_plugin_paths(
    data_root: Result<PathBuf, String>,
    installed_skills: Result<PathBuf, String>,
    installed_skills_is_dir: bool,
    working_dir: &Path,
) -> Result<(PathBuf, PathBuf), ClaudePluginDirResolution> {
    let data_root = match data_root {
        Ok(path) if path.is_absolute() => path,
        Ok(path) => {
            return Err(skipped_resolution(
                format!(
                    "the resolved Vertebrae app-data root is not absolute: {}",
                    path.display()
                ),
                None,
                working_dir,
            ));
        }
        Err(error) => {
            return Err(skipped_resolution(
                format!("the Vertebrae app-data root could not be resolved: {error}"),
                None,
                working_dir,
            ));
        }
    };

    let installed_skills = match installed_skills {
        Ok(path) => path,
        Err(error) => {
            return Err(skipped_resolution(
                format!("the installed-skills directory could not be resolved: {error}"),
                None,
                working_dir,
            ));
        }
    };

    let expected_skills = data_root.join("skills");
    if installed_skills != expected_skills {
        return Err(skipped_resolution(
            format!(
                "the installed-skills directory ({}) is inconsistent with the app-data root ({})",
                installed_skills.display(),
                data_root.display()
            ),
            None,
            working_dir,
        ));
    }

    if !installed_skills_is_dir {
        return Err(skipped_resolution(
            format!(
                "the installed-skills path is missing or is not a directory: {}",
                installed_skills.display()
            ),
            Some(&installed_skills),
            working_dir,
        ));
    }

    Ok((data_root, installed_skills))
}

fn resolve_claude_plugin_dir_for_validated_paths(
    data_root: PathBuf,
    installed_skills: PathBuf,
    version_output: Result<String, String>,
    working_dir: &Path,
) -> ClaudePluginDirResolution {
    let version_output = match version_output {
        Ok(output) => output,
        Err(error) => {
            return skipped_resolution(error, Some(&installed_skills), working_dir);
        }
    };
    let Some(version) = parse_claude_version(&version_output) else {
        return skipped_resolution(
            format!(
                "Claude Code returned unparseable version output: {}",
                sanitize_detail(version_output.trim())
            ),
            Some(&installed_skills),
            working_dir,
        );
    };

    if version < MINIMUM_CLAUDE_VERSION {
        return skipped_resolution(
            format!(
                "Claude Code {version} is older than the minimum supported version {MINIMUM_CLAUDE_VERSION}"
            ),
            Some(&installed_skills),
            working_dir,
        );
    }

    ClaudePluginDirResolution {
        plugin_root: Some(data_root),
        warning: None,
    }
}

fn skipped_resolution(
    reason: String,
    installed_skills: Option<&Path>,
    working_dir: &Path,
) -> ClaudePluginDirResolution {
    let source = installed_skills
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "<data_dir>/skills".to_string());
    let destination = working_dir.join(".claude").join("skills");

    ClaudePluginDirResolution {
        plugin_root: None,
        warning: Some(format!(
            "Vertebrae skipped automatic installed-skill loading because {reason}. Update Claude Code to version {MINIMUM_CLAUDE_VERSION} or newer. This session will continue with Claude's native project and user skills. As an optional fallback, manually copy the skill folders from {source}/ into {}/.",
            destination.display()
        )),
    }
}

fn parse_claude_version(output: &str) -> Option<Version> {
    let output = output.trim();
    let candidate = output
        .strip_prefix("Claude Code ")
        .or_else(|| output.strip_suffix(" (Claude Code)"))?;
    let candidate = candidate.strip_prefix('v').unwrap_or(candidate);
    Version::parse(candidate).ok()
}

fn sanitize_detail(detail: &str) -> String {
    const MAX_CHARS: usize = 160;
    detail
        .chars()
        .take(MAX_CHARS)
        .flat_map(char::escape_default)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (PathBuf, PathBuf, PathBuf) {
        let data_root = PathBuf::from("/absolute/vertebrae-data");
        let installed_skills = data_root.join("skills");
        let working_dir = PathBuf::from("/absolute/project");
        (data_root, installed_skills, working_dir)
    }

    fn resolve_with_version(version: Result<String, String>) -> ClaudePluginDirResolution {
        let (data_root, installed_skills, working_dir) = paths();
        resolve_claude_plugin_dir_from_checks(
            Ok(data_root),
            Ok(installed_skills),
            true,
            version,
            &working_dir,
        )
    }

    #[test]
    fn parses_supported_claude_code_version_shapes() {
        for (output, expected) in [
            ("2.0.25 (Claude Code)", Version::new(2, 0, 25)),
            ("Claude Code v2.1.0\n", Version::new(2, 1, 0)),
        ] {
            assert_eq!(parse_claude_version(output), Some(expected));
        }
    }

    #[test]
    fn rejects_unparseable_or_incomplete_versions() {
        for output in [
            "Claude Code unknown",
            "2.0",
            "2.0.25.1",
            "",
            "Node 22.0.0\nClaude Code 2.0.24",
            "22.0.0 (Node) Claude Code 2.0.24",
        ] {
            assert_eq!(parse_claude_version(output), None, "output: {output}");
        }
    }

    #[test]
    fn supported_version_uses_manifestless_app_data_root() {
        let (data_root, installed_skills, _) = paths();
        let resolution = resolve_with_version(Ok("Claude Code 2.0.25".to_string()));

        assert_eq!(resolution.plugin_root, Some(data_root));
        assert_eq!(resolution.warning, None);
        assert_eq!(
            installed_skills,
            PathBuf::from("/absolute/vertebrae-data/skills")
        );
    }

    #[test]
    fn newer_major_version_is_supported() {
        let resolution = resolve_with_version(Ok("3.0.0 (Claude Code)".to_string()));
        assert_eq!(resolution.plugin_root, Some(paths().0));
        assert_eq!(resolution.warning, None);
    }

    #[test]
    fn prerelease_of_minimum_version_is_not_supported() {
        let resolution = resolve_with_version(Ok("2.0.25-beta.1 (Claude Code)".to_string()));
        assert_eq!(resolution.plugin_root, None);
        assert!(
            resolution
                .warning
                .expect("minimum prerelease should warn")
                .contains("older than the minimum supported version 2.0.25")
        );
    }

    #[test]
    fn old_failed_and_unparseable_versions_skip_injection_with_fallback_warning() {
        let cases = [
            Ok("2.0.24 (Claude Code)".to_string()),
            Err("version command failed".to_string()),
            Ok("Claude Code unknown".to_string()),
        ];

        for version in cases {
            let resolution = resolve_with_version(version);
            assert_eq!(resolution.plugin_root, None);
            let warning = resolution.warning.expect("skip should warn");
            assert!(warning.contains("Update Claude Code to version 2.0.25 or newer"));
            assert!(warning.contains("/absolute/vertebrae-data/skills/"));
            assert!(warning.contains("/absolute/project/.claude/skills/"));
            assert!(warning.contains("continue with Claude's native project and user skills"));
        }
    }

    #[test]
    fn path_resolution_failures_mismatches_and_missing_directories_skip_injection() {
        let (_, _, working_dir) = paths();
        let cases = [
            (
                Err("no home".to_string()),
                Err("no home".to_string()),
                false,
            ),
            (
                Ok(PathBuf::from("relative/data")),
                Ok(PathBuf::from("relative/data/skills")),
                true,
            ),
            (
                Ok(PathBuf::from("/absolute/data")),
                Err("skills unavailable".to_string()),
                false,
            ),
            (
                Ok(PathBuf::from("/absolute/data")),
                Ok(PathBuf::from("/somewhere/else/skills")),
                true,
            ),
            (
                Ok(PathBuf::from("/absolute/data")),
                Ok(PathBuf::from("/absolute/data/skills")),
                false,
            ),
        ];

        for (data_root, installed_skills, installed_skills_is_dir) in cases {
            let resolution = resolve_claude_plugin_dir_from_checks(
                data_root,
                installed_skills,
                installed_skills_is_dir,
                Ok("2.0.25 (Claude Code)".to_string()),
                &working_dir,
            );
            assert_eq!(resolution.plugin_root, None);
            let warning = resolution.warning.expect("skip should warn");
            assert!(warning.contains("/absolute/project/.claude/skills/"));
        }
    }

    #[test]
    fn invalid_paths_short_circuit_before_version_probe() {
        let (_, _, working_dir) = paths();
        let mut probe_called = false;

        let resolution = resolve_claude_plugin_dir_with_probe(
            Ok(PathBuf::from("relative/data")),
            Ok(PathBuf::from("relative/data/skills")),
            true,
            &working_dir,
            || {
                probe_called = true;
                Ok("2.0.25 (Claude Code)".to_string())
            },
        );

        assert!(resolution.plugin_root.is_none());
        assert!(resolution.warning.is_some());
        assert!(
            !probe_called,
            "path failures must not spawn a version probe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn version_query_is_non_interactive_and_uses_the_resolved_binary() {
        use std::os::unix::fs::PermissionsExt;

        let tempdir = tempfile::tempdir().expect("create tempdir");
        let binary = tempdir.path().join("resolved-claude");
        std::fs::write(
            &binary,
            "#!/bin/sh\n[ \"$1\" = \"--version\" ] || exit 9\nprintf '2.0.25 (Claude Code)\\n'\n",
        )
        .expect("write fake Claude binary");
        let mut permissions = std::fs::metadata(&binary)
            .expect("read fake binary metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary, permissions).expect("make fake binary executable");

        assert_eq!(
            query_claude_version(&binary, "/usr/bin:/bin"),
            Ok("2.0.25 (Claude Code)\n".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn version_query_times_out_instead_of_blocking_session_startup() {
        use std::os::unix::fs::PermissionsExt;

        let tempdir = tempfile::tempdir().expect("create tempdir");
        let binary = tempdir.path().join("hanging-claude");
        std::fs::write(&binary, "#!/bin/sh\nexec sleep 30\n").expect("write fake Claude binary");
        let mut permissions = std::fs::metadata(&binary)
            .expect("read fake binary metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&binary, permissions).expect("make fake binary executable");

        let started_at = Instant::now();
        let error =
            query_claude_version_with_timeout(&binary, "/usr/bin:/bin", Duration::from_millis(50))
                .expect_err("hanging version probe should fail");

        assert!(error.contains("timed out"));
        assert!(started_at.elapsed() < Duration::from_secs(2));
    }
}
