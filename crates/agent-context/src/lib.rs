//! Embedded agent-context docs for local chat sessions. Only the root index is
//! injected; the agent reads deeper docs from the staged copy on disk.

use std::fs;
use std::path::{Path, PathBuf};

use include_dir::{Dir, File, include_dir};
use thiserror::Error;

static DOCS_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../docs/agent-context");

pub const ROOT_INDEX: &str = "index.md";

#[derive(Debug, Error)]
pub enum AgentContextError {
    #[error("Failed to create directory {path}: {reason}")]
    CreateDir { path: PathBuf, reason: String },

    #[error("Failed to write agent-context doc {target}: {reason}")]
    WriteFile { target: PathBuf, reason: String },

    #[error("Failed to replace staged agent-context docs at {path}: {reason}")]
    Replace { path: PathBuf, reason: String },
}

pub fn root_index() -> &'static str {
    doc(ROOT_INDEX).expect("docs/agent-context/index.md is embedded")
}

pub fn doc(relative_path: impl AsRef<Path>) -> Option<&'static str> {
    DOCS_DIR
        .get_file(relative_path.as_ref())
        .and_then(File::contents_utf8)
}

pub fn doc_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    collect_files(&DOCS_DIR, &mut paths);
    paths.sort_unstable();
    paths
}

/// Replaces any previous copy so docs removed from the build do not linger.
/// Returns the number of files written.
pub fn install(target_dir: impl AsRef<Path>) -> Result<usize, AgentContextError> {
    let target_dir = target_dir.as_ref();
    let staging_dir = staging_path(target_dir);
    if staging_dir.exists() {
        remove_dir_all(&staging_dir)?;
    }

    let mut written = 0;
    for relative_path in doc_paths() {
        let target_path = staging_dir.join(&relative_path);
        if let Some(parent) = target_path.parent() {
            create_dir_all(parent)?;
        }
        let contents = DOCS_DIR
            .get_file(&relative_path)
            .map(File::contents)
            .unwrap_or_default();
        fs::write(&target_path, contents).map_err(|e| AgentContextError::WriteFile {
            target: target_path.clone(),
            reason: e.to_string(),
        })?;
        written += 1;
    }

    if target_dir.exists() {
        remove_dir_all(target_dir)?;
    }
    fs::rename(&staging_dir, target_dir).map_err(|e| AgentContextError::Replace {
        path: target_dir.to_path_buf(),
        reason: e.to_string(),
    })?;
    Ok(written)
}

/// A short preamble plus the root index with links rewritten to absolute
/// paths under `docs_root`.
pub fn developer_instructions(docs_root: &Path) -> String {
    format!(
        "Vertebrae agent context: the index below describes this app and what you can do with it. \
Each entry links to a doc on disk; read a doc with your file-reading tool only when its \"Load when\" hint matches the conversation, \
then follow the links inside it (paths relative to that file). Load the Permissions doc before running any vtb command that changes state. \
Docs root: {root}\n\n{index}",
        root = docs_root.display(),
        index = absolutize_links(root_index(), docs_root),
    )
}

/// Targets are wrapped in angle brackets because staged paths may contain
/// spaces (for example `Application Support`).
fn absolutize_links(markdown: &str, docs_root: &Path) -> String {
    let mut rendered = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(start) = rest.find("](") {
        let (before, after) = rest.split_at(start + 2);
        rendered.push_str(before);
        let Some(end) = after.find(')') else {
            rest = after;
            break;
        };
        let target = &after[..end];
        if is_relative_doc_link(target) {
            rendered.push('<');
            rendered.push_str(&docs_root.join(target).display().to_string());
            rendered.push('>');
        } else {
            rendered.push_str(target);
        }
        rest = &after[end..];
    }
    rendered.push_str(rest);
    rendered
}

fn is_relative_doc_link(target: &str) -> bool {
    !target.is_empty()
        && !target.contains("://")
        && !target.starts_with('#')
        && !target.starts_with('/')
        && !target.starts_with('<')
}

fn collect_files(dir: &Dir<'_>, paths: &mut Vec<PathBuf>) {
    for nested in dir.dirs() {
        collect_files(nested, paths);
    }
    paths.extend(dir.files().map(|file| file.path().to_path_buf()));
}

fn staging_path(target_dir: &Path) -> PathBuf {
    let name = target_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "agent-context".into());
    target_dir.with_file_name(format!(".{name}.staging-{}", std::process::id()))
}

fn create_dir_all(path: &Path) -> Result<(), AgentContextError> {
    fs::create_dir_all(path).map_err(|e| AgentContextError::CreateDir {
        path: path.to_path_buf(),
        reason: e.to_string(),
    })
}

fn remove_dir_all(path: &Path) -> Result<(), AgentContextError> {
    fs::remove_dir_all(path).map_err(|e| AgentContextError::Replace {
        path: path.to_path_buf(),
        reason: e.to_string(),
    })
}

/// Returns `None` when the link escapes the docs root.
#[cfg(test)]
fn resolve_link(from: &Path, target: &str) -> Option<PathBuf> {
    use std::path::Component;

    let target = target.split('#').next().unwrap_or_default();
    let mut resolved = PathBuf::new();
    let base = from.parent().unwrap_or_else(|| Path::new(""));
    for component in base.join(target).components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::ParentDir => {
                if !resolved.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(resolved)
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, VecDeque};

    use super::*;

    /// Leaf docs stay about one screen; larger topics become a sub-index.
    const MAX_DOC_LINES: usize = 80;
    const MAX_ROOT_ENTRIES: usize = 12;

    fn links(markdown: &str) -> Vec<String> {
        let mut found = Vec::new();
        let mut rest = markdown;
        while let Some(start) = rest.find("](") {
            let after = &rest[start + 2..];
            let Some(end) = after.find(')') else { break };
            found.push(after[..end].to_string());
            rest = &after[end..];
        }
        found
    }

    fn doc_links(path: &Path) -> Vec<PathBuf> {
        let body = doc(path).expect("doc is embedded");
        links(body)
            .into_iter()
            .filter(|target| is_relative_doc_link(target))
            .map(|target| {
                resolve_link(path, &target).unwrap_or_else(|| {
                    panic!("{} links outside the docs root: {target}", path.display())
                })
            })
            .collect()
    }

    fn index_entries(body: &str) -> Vec<&str> {
        body.lines()
            .filter(|line| line.starts_with("- ["))
            .collect()
    }

    #[test]
    fn every_relative_link_resolves_to_an_embedded_doc() {
        let embedded: BTreeSet<PathBuf> = doc_paths().into_iter().collect();
        for path in &embedded {
            for target in doc_links(path) {
                assert!(
                    embedded.contains(&target),
                    "{} links to missing doc {}",
                    path.display(),
                    target.display()
                );
            }
        }
    }

    #[test]
    fn every_doc_is_reachable_from_the_root_index() {
        let mut seen = BTreeSet::from([PathBuf::from(ROOT_INDEX)]);
        let mut queue = VecDeque::from([PathBuf::from(ROOT_INDEX)]);
        while let Some(path) = queue.pop_front() {
            for target in doc_links(&path) {
                if seen.insert(target.clone()) {
                    queue.push_back(target);
                }
            }
        }
        let unreachable: Vec<_> = doc_paths()
            .into_iter()
            .filter(|path| !seen.contains(path))
            .collect();
        assert!(unreachable.is_empty(), "unreachable docs: {unreachable:?}");
    }

    #[test]
    fn docs_stay_within_one_screen() {
        for path in doc_paths() {
            let lines = doc(&path).expect("doc is embedded").lines().count();
            assert!(
                lines <= MAX_DOC_LINES,
                "{} has {lines} lines; split it into a sub-index",
                path.display()
            );
        }
    }

    #[test]
    fn every_index_entry_has_a_summary_and_load_when_hint() {
        for path in doc_paths()
            .into_iter()
            .filter(|path| path.file_name().is_some_and(|name| name == "index.md"))
        {
            let body = doc(&path).expect("index is embedded");
            let lines: Vec<&str> = body.lines().collect();
            let entries: Vec<usize> = lines
                .iter()
                .enumerate()
                .filter(|(_, line)| line.starts_with("- ["))
                .map(|(number, _)| number)
                .collect();
            assert!(!entries.is_empty(), "{} lists no entries", path.display());
            for number in entries {
                let entry = lines[number];
                assert!(
                    entry
                        .split_once("): ")
                        .is_some_and(|(_, summary)| !summary.trim().is_empty()),
                    "{} entry lacks a one-line summary: {entry}",
                    path.display()
                );
                assert!(
                    lines
                        .get(number + 1)
                        .is_some_and(|hint| hint.trim_start().starts_with("Load when:")),
                    "{} entry lacks a 'Load when' hint: {entry}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn root_index_lists_only_top_level_entry_points() {
        let entries = index_entries(root_index());
        assert!(
            (8..=MAX_ROOT_ENTRIES).contains(&entries.len()),
            "root index has {} entries",
            entries.len()
        );
        for target in doc_links(Path::new(ROOT_INDEX)) {
            let depth = target.components().count();
            let is_sub_index = depth == 2 && target.ends_with("index.md");
            assert!(
                depth == 1 || is_sub_index,
                "root index must link top-level docs or area indexes, found {}",
                target.display()
            );
        }
    }

    #[test]
    fn root_index_points_agents_at_permissions_before_mutating() {
        let permissions = index_entries(root_index())
            .into_iter()
            .find(|entry| entry.contains("(permissions.md)"))
            .expect("root index links the permissions doc");
        assert!(permissions.contains("consent"));
        assert!(root_index().contains("before running any `vtb` command that changes state"));
    }

    #[test]
    fn developer_instructions_inject_only_the_index_with_absolute_links() {
        let root = Path::new("/Users/example/Library/Application Support/Vertebrae/agent-context");
        let instructions = developer_instructions(root);

        assert!(instructions.contains("# Vertebrae agent context"));
        assert!(instructions.contains(
            "(</Users/example/Library/Application Support/Vertebrae/agent-context/permissions.md>)"
        ));
        assert!(instructions.contains(
            "(</Users/example/Library/Application Support/Vertebrae/agent-context/workflows/index.md>)"
        ));
        assert!(!instructions.contains("](overview.md)"));
        let leaf = doc("workflows/steps/route/partitions.md").expect("leaf is embedded");
        assert!(
            !instructions.contains(leaf.lines().nth(2).expect("leaf has a purpose line")),
            "leaf doc bodies must not be injected"
        );
    }

    #[test]
    fn install_stages_every_doc_and_removes_stale_files() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let target = temp.path().join("agent-context");
        fs::create_dir_all(target.join("old")).expect("create stale dir");
        fs::write(target.join("old/stale.md"), "stale").expect("write stale doc");

        let written = install(&target).expect("install docs");

        assert_eq!(written, doc_paths().len());
        assert!(!target.join("old/stale.md").exists());
        assert_eq!(
            fs::read_to_string(target.join(ROOT_INDEX)).expect("read staged index"),
            root_index()
        );
        assert!(target.join("templating/state.md").is_file());
        let leftovers: Vec<_> = fs::read_dir(temp.path())
            .expect("read temp dir")
            .map(|entry| entry.expect("dir entry").file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("agent-context")]);
    }

    #[test]
    fn resolve_link_normalizes_parent_segments() {
        assert_eq!(
            resolve_link(
                Path::new("workflows/steps/route/index.md"),
                "../../../templating/handoffs.md"
            ),
            Some(PathBuf::from("templating/handoffs.md"))
        );
        assert_eq!(resolve_link(Path::new("index.md"), "../outside.md"), None);
    }
}
