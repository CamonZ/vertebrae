//! Embedded Vertebrae skills and install helpers shared by the CLI and GUI.
//!
//! The checked-in repository `skills/` directory is the canonical source for
//! consumer-installed skills. Repo-internal workflow helpers live elsewhere and
//! are intentionally not embedded here.

use std::fs;
use std::path::{Path, PathBuf};

use include_dir::{Dir, include_dir};
use thiserror::Error;

/// Embedded skills directory at compile time.
static SKILLS_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../skills");

/// Information reported after one embedded file is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledSkillFile {
    /// Path of the embedded file relative to the skills root.
    pub relative_path: PathBuf,
    /// Absolute or caller-relative target path written on disk.
    pub target_path: PathBuf,
}

/// Errors returned by the embedded skills API.
#[derive(Debug, Error)]
pub enum SkillsAssetError {
    /// Failed to create the target directory or a nested skill directory.
    #[error("Failed to create directory {path}: {reason}")]
    CreateDir { path: PathBuf, reason: String },

    /// Failed to write an embedded skill file.
    #[error("Failed to write embedded skill {relative_path} to {target}: {reason}")]
    WriteFile {
        relative_path: PathBuf,
        target: PathBuf,
        reason: String,
    },
}

/// Return the names of all embedded top-level skills, sorted for stable UI and
/// test output.
pub fn list_embedded_skills() -> Vec<String> {
    let mut skills = SKILLS_DIR
        .dirs()
        .filter_map(|dir| dir.path().file_name())
        .filter_map(|name| name.to_str())
        .map(installed_skill_name)
        .collect::<Vec<_>>();
    skills.sort_unstable();
    skills
}

/// Install embedded skills into `target_dir`, reporting each written file.
///
/// The callback is invoked after each file is successfully written, with both
/// the embedded relative path and concrete target path. The returned count is
/// the number of files installed.
pub fn install_embedded_skills_with_progress<F>(
    target_dir: impl AsRef<Path>,
    mut on_file_installed: F,
) -> Result<usize, SkillsAssetError>
where
    F: FnMut(&InstalledSkillFile),
{
    let target_dir = target_dir.as_ref();
    create_dir_all(target_dir)?;

    let mut copied = 0;
    install_dir(&SKILLS_DIR, target_dir, &mut on_file_installed, &mut copied)?;
    Ok(copied)
}

/// Install embedded skills into `target_dir`.
///
/// This is a convenience wrapper for callers that do not need progress events.
pub fn install_embedded_skills(target_dir: impl AsRef<Path>) -> Result<usize, SkillsAssetError> {
    install_embedded_skills_with_progress(target_dir, |_| {})
}

fn install_dir<F>(
    source_dir: &Dir<'_>,
    target_root: &Path,
    on_file_installed: &mut F,
    copied: &mut usize,
) -> Result<(), SkillsAssetError>
where
    F: FnMut(&InstalledSkillFile),
{
    for dir in source_dir.dirs() {
        create_dir_all(&target_root.join(installed_relative_path(dir.path())))?;
        install_dir(dir, target_root, on_file_installed, copied)?;
    }

    for file in source_dir.files() {
        let relative_path = installed_relative_path(file.path());
        let target_path = target_root.join(&relative_path);

        if let Some(parent) = target_path.parent() {
            create_dir_all(parent)?;
        }

        fs::write(&target_path, file.contents()).map_err(|e| SkillsAssetError::WriteFile {
            relative_path: relative_path.clone(),
            target: target_path.clone(),
            reason: e.to_string(),
        })?;

        *copied += 1;
        on_file_installed(&InstalledSkillFile {
            relative_path,
            target_path,
        });
    }

    Ok(())
}

fn installed_relative_path(source_path: &Path) -> PathBuf {
    let mut components = source_path.components();
    let Some(first) = components.next() else {
        return PathBuf::new();
    };

    let mut installed = PathBuf::new();
    installed.push(installed_skill_name(&first.as_os_str().to_string_lossy()));
    for component in components {
        installed.push(component.as_os_str());
    }
    installed
}

fn installed_skill_name(source_name: &str) -> String {
    if source_name.starts_with("vtb-") {
        source_name.to_string()
    } else {
        format!("vtb-{source_name}")
    }
}

fn create_dir_all(path: &Path) -> Result<(), SkillsAssetError> {
    fs::create_dir_all(path).map_err(|e| SkillsAssetError::CreateDir {
        path: path.to_path_buf(),
        reason: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURATED_SKILLS: [&str; 27] = [
        "vtb-add",
        "vtb-archive",
        "vtb-artifact",
        "vtb-blockers",
        "vtb-check-item",
        "vtb-criterion-ref",
        "vtb-delete",
        "vtb-depend",
        "vtb-init",
        "vtb-list",
        "vtb-path",
        "vtb-ready",
        "vtb-ref",
        "vtb-refs",
        "vtb-run",
        "vtb-run-workflow",
        "vtb-section",
        "vtb-sections",
        "vtb-show",
        "vtb-step",
        "vtb-transition-to",
        "vtb-uncheck-item",
        "vtb-undepend",
        "vtb-unref",
        "vtb-unsection",
        "vtb-update",
        "vtb-workflow",
    ];

    fn curated_skills() -> Vec<String> {
        CURATED_SKILLS
            .iter()
            .map(|skill| skill.to_string())
            .collect()
    }

    #[test]
    fn lists_exact_curated_skill_set() {
        assert_eq!(list_embedded_skills(), curated_skills());
    }

    #[test]
    fn embedded_skills_exclude_internal_and_removed_topics() {
        let skills = list_embedded_skills();

        for excluded in [
            "vtb-gui-dev",
            "vtb-execution",
            "vtb-status",
            "vtb-start-step",
            "vtb-complete-step",
            "vtb-reject-step",
            "vtb-step-done",
            "vtb-review",
            "vtb-implement",
        ] {
            assert!(
                !skills.contains(&excluded.to_string()),
                "{excluded} should not be embedded for vtb init"
            );
        }
    }

    #[test]
    fn installs_exact_curated_skill_set_and_reports_each_file() {
        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let target = temp_dir.path().join(".claude/skills");
        let mut progress = Vec::new();

        let copied = install_embedded_skills_with_progress(&target, |file| {
            progress.push((file.relative_path.clone(), file.target_path.clone()));
        })
        .expect("install embedded skills");

        assert_eq!(copied, CURATED_SKILLS.len());
        assert_eq!(
            progress.len(),
            CURATED_SKILLS.len(),
            "progress should fire once per installed file"
        );

        let mut installed = fs::read_dir(&target)
            .expect("read skills target")
            .map(|entry| {
                entry
                    .expect("read entry")
                    .file_name()
                    .into_string()
                    .expect("skill names are utf8")
            })
            .collect::<Vec<_>>();
        installed.sort_unstable();

        assert_eq!(installed, curated_skills());

        for skill in CURATED_SKILLS {
            let skill_file = target.join(skill).join("SKILL.md");
            let content = fs::read_to_string(&skill_file)
                .unwrap_or_else(|e| panic!("read {}: {e}", skill_file.display()));
            assert!(
                !content.trim().is_empty(),
                "{} should not be empty",
                skill_file.display()
            );
        }

        assert!(
            !target.join("gui-dev").exists(),
            "gui-dev is repo-internal and must not be installed"
        );
        assert!(
            !target.join("execution").exists(),
            "execution was removed and must not be installed"
        );
    }

    #[test]
    fn installs_provider_neutral_bundle_without_modifying_project_skill_roots() {
        let temp_dir = tempfile::tempdir().expect("create tempdir");
        let app_skills = temp_dir.path().join("app-data/skills");
        let project = temp_dir.path().join("project");
        let claude_target = project.join(".claude/skills");
        let agents_target = project.join(".agents/skills");
        fs::create_dir_all(&claude_target).expect("create claude skills root");
        fs::create_dir_all(&agents_target).expect("create agents skills root");
        fs::write(claude_target.join("custom.md"), "claude custom").expect("write claude sentinel");
        fs::write(agents_target.join("custom.md"), "agents custom").expect("write agents sentinel");

        let copied = install_embedded_skills(&app_skills).expect("install provider-neutral skills");

        assert_eq!(copied, CURATED_SKILLS.len());
        assert!(app_skills.join("vtb-add/SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(claude_target.join("custom.md")).expect("read claude sentinel"),
            "claude custom"
        );
        assert_eq!(
            fs::read_to_string(agents_target.join("custom.md")).expect("read agents sentinel"),
            "agents custom"
        );
        assert_eq!(
            fs::read_dir(&claude_target)
                .expect("read claude root")
                .count(),
            1
        );
        assert_eq!(
            fs::read_dir(&agents_target)
                .expect("read agents root")
                .count(),
            1
        );
    }
}
