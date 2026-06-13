//! Embedded Vertebrae skills and copy helpers shared by the CLI and GUI.
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
pub fn list_embedded_skills() -> Vec<&'static str> {
    let mut skills = SKILLS_DIR
        .dirs()
        .filter_map(|dir| dir.path().file_name())
        .filter_map(|name| name.to_str())
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
        create_dir_all(&target_root.join(dir.path()))?;
        install_dir(dir, target_root, on_file_installed, copied)?;
    }

    for file in source_dir.files() {
        let relative_path = file.path().to_path_buf();
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

fn create_dir_all(path: &Path) -> Result<(), SkillsAssetError> {
    fs::create_dir_all(path).map_err(|e| SkillsAssetError::CreateDir {
        path: path.to_path_buf(),
        reason: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURATED_SKILLS: [&str; 26] = [
        "add",
        "archive",
        "blockers",
        "check-item",
        "criterion-ref",
        "delete",
        "depend",
        "init",
        "list",
        "path",
        "ready",
        "ref",
        "refs",
        "run",
        "run-workflow",
        "section",
        "sections",
        "step",
        "transition-to",
        "uncheck-item",
        "undepend",
        "unref",
        "unsection",
        "update",
        "vtb-show",
        "workflow",
    ];

    #[test]
    fn lists_exact_curated_skill_set() {
        assert_eq!(list_embedded_skills(), CURATED_SKILLS);
    }

    #[test]
    fn embedded_skills_exclude_internal_and_removed_topics() {
        let skills = list_embedded_skills();

        for excluded in [
            "gui-dev",
            "execution",
            "status",
            "start-step",
            "complete-step",
            "reject-step",
            "step-done",
            "review",
            "implement",
        ] {
            assert!(
                !skills.contains(&excluded),
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

        assert_eq!(installed, CURATED_SKILLS);

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
}
