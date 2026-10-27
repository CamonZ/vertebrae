use super::{invalid, AssociationWorktree, CommandError};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use vertebrae_sacrum_client::VertebraeConfigFile;

pub(super) struct Scope {
    pub root: PathBuf,
    pub config: VertebraeConfigFile,
    pub worktrees: Vec<AssociationWorktree>,
}

const GIT_OUTPUT_LIMIT: u64 = 256_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Bounded `git worktree list`: output is capped while reading and a stuck
/// process is killed and reaped at the deadline. Blocking; call from a blocking context.
fn git_worktree_list(root: &Path) -> Result<Vec<u8>, CommandError> {
    let unavailable = || invalid("Git worktree inventory is unavailable.");
    let mut child = Command::new("git")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-C")
        .arg(root)
        .args(["worktree", "list", "--porcelain", "-z"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| unavailable())?;
    let stdout = child.stdout.take().ok_or_else(unavailable)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let read = stdout.take(GIT_OUTPUT_LIMIT + 1).read_to_end(&mut buffer);
        let _ = sender.send(read.map(|_| buffer));
    });
    match receiver.recv_timeout(GIT_TIMEOUT) {
        Ok(Ok(buffer)) if buffer.len() as u64 <= GIT_OUTPUT_LIMIT => {
            let status = child.wait().map_err(|_| unavailable())?;
            if status.success() {
                Ok(buffer)
            } else {
                Err(unavailable())
            }
        }
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Err(unavailable())
        }
    }
}

fn worktrees(root: &Path) -> Result<Vec<AssociationWorktree>, CommandError> {
    let stdout = git_worktree_list(root)?;
    let text = String::from_utf8_lossy(&stdout);
    let mut entries: Vec<AssociationWorktree> = vec![];
    for field in text.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Ok(path) = std::fs::canonicalize(path) {
                entries.push(AssociationWorktree {
                    path: path.to_string_lossy().into(),
                    branch: None,
                });
            }
        } else if let Some(branch) = field.strip_prefix("branch refs/heads/") {
            if let Some(entry) = entries.last_mut() {
                entry.branch = Some(branch.into());
            }
        }
    }
    Ok(entries)
}

/// The conversation root must be a registered project or one of its Git worktrees.
pub(super) fn scope(root: &str) -> Result<Scope, CommandError> {
    let root = std::fs::canonicalize(root)
        .map_err(|_| invalid("Conversation workspace is unavailable."))?;
    let config = vertebrae_sacrum_client::load_config_file()
        .map_err(|_| invalid("Could not read shared settings."))?;
    for project in config.projects.values() {
        let Ok(entries) = worktrees(Path::new(&project.path)) else {
            continue;
        };
        if entries.iter().any(|w| Path::new(&w.path) == root) {
            return Ok(Scope {
                root,
                worktrees: entries,
                config,
            });
        }
    }
    Err(invalid(
        "Conversation workspace is not registered to a project.",
    ))
}

/// Collect every string, plus explicit `cwd`/`workdir` values, from tool JSON.
fn collect(
    value: &serde_json::Value,
    strings: &mut Vec<String>,
    dirs: &mut Vec<String>,
    depth: usize,
) {
    if depth > 8 || strings.len() >= 64 {
        return;
    }
    match value {
        serde_json::Value::String(s) => strings.push(s.clone()),
        serde_json::Value::Array(a) => a
            .iter()
            .take(32)
            .for_each(|v| collect(v, strings, dirs, depth + 1)),
        serde_json::Value::Object(o) => {
            for (key, v) in o.iter().take(32) {
                match v.as_str() {
                    Some(dir)
                        if matches!(
                            key.as_str(),
                            "cwd" | "workdir" | "working_directory" | "working_dir"
                        ) =>
                    {
                        dirs.push(dir.into())
                    }
                    _ => collect(v, strings, dirs, depth + 1),
                }
            }
        }
        _ => (),
    }
}

fn is_explicit_path(token: &str) -> bool {
    !token.contains("://")
        && (token.starts_with('/')
            || token.starts_with("./")
            || token.starts_with("../")
            || token == "..")
}

/// Worktrees touched by a tool call/result. Only real `git worktree list` entries count.
pub(super) fn observed_worktrees(
    text: &str,
    root: &Path,
    inventory: &[AssociationWorktree],
) -> Vec<AssociationWorktree> {
    let mut strings = vec![text.to_owned()];
    let mut dirs = vec![];
    if let Ok(value) = serde_json::from_str(text) {
        collect(&value, &mut strings, &mut dirs, 0);
    }
    dirs.sort();
    dirs.dedup();
    // A single explicit execution directory is the base for relative paths.
    let base = if dirs.len() == 1 {
        root.join(&dirs[0])
    } else {
        root.into()
    };
    let mut paths: Vec<(PathBuf, bool)> = dirs.iter().map(|d| (root.join(d), true)).collect();
    for value in &strings {
        let tokens = value.split(|c: char| {
            c.is_whitespace()
                || [
                    '\'', '"', '`', '(', ')', ',', ';', '=', '{', '}', '[', ']', '<', '>', '“',
                    '”', '‘', '’',
                ]
                .contains(&c)
        });
        for token in tokens
            .chain([value.trim()])
            .filter(|s| s.contains('/'))
            .take(64)
        {
            // Bare `a/b` tokens (URLs, "and/or") count only when their first
            // component already exists under the base directory.
            let explicit = is_explicit_path(token)
                || (!token.contains("://")
                    && token
                        .split('/')
                        .find(|part| !part.is_empty())
                        .is_some_and(|first| base.join(first).exists()));
            paths.push((base.join(token), explicit));
        }
    }
    let mut found = vec![];
    for (path, explicit) in paths.into_iter().take(128) {
        // A write may name a new file: walk up to the nearest existing ancestor.
        let mut ancestor = path.as_path();
        let canonical = loop {
            if let Ok(value) = std::fs::canonicalize(ancestor) {
                break Some(value);
            }
            match ancestor.parent().filter(|_| explicit) {
                Some(parent) => ancestor = parent,
                None => break None,
            }
        };
        let entry = canonical.and_then(|c| {
            inventory
                .iter()
                .filter(|w| c.starts_with(&w.path))
                .max_by_key(|w| w.path.len())
        });
        if let Some(entry) = entry.filter(|e| !found.contains(*e)) {
            found.push(entry.clone());
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn extracts_explicit_paths_and_ignores_urls_and_prose() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let main = root.join("main");
        let work = root.join("feature-97a3edab");
        std::fs::create_dir_all(main.join("src")).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let inventory = vec![AssociationWorktree {
            path: work.to_string_lossy().into(),
            branch: Some("feature".into()),
        }];
        let observe = |text: &str| observed_worktrees(text, &main, &inventory);
        assert!(observe("see https://example.com/docs/page").is_empty());
        assert!(observe("use and/or here").is_empty());
        assert_eq!(observe("write ../feature-97a3edab/new.rs"), inventory);
        assert_eq!(observe(&format!("cat {}/a.rs", work.display())), inventory);
        let created = format!(
            "Created worktree at “{}” on branch “feature”.",
            work.display()
        );
        assert_eq!(observe(&created), inventory);
        assert_eq!(
            observe(r#"{"working_directory":"../feature-97a3edab","cmd":"cat new.rs"}"#),
            inventory
        );
        assert_eq!(
            observe(r#"{"workdir":"../feature-97a3edab","cmd":"ls"}"#),
            inventory
        );
    }

    #[test]
    fn execution_directory_aliases_resolve_relative_paths_into_nested_worktrees() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let main = root.join("main");
        let work = root.join("work with spaces");
        let nested = work.join("nested");
        std::fs::create_dir(&main).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        let inventory = vec![
            AssociationWorktree {
                path: work.to_string_lossy().into(),
                branch: None,
            },
            AssociationWorktree {
                path: nested.to_string_lossy().into(),
                branch: None,
            },
        ];
        for key in ["cwd", "workdir", "working_directory", "working_dir"] {
            let text = serde_json::json!({ key: work, "cmd": "cat nested/new.rs" }).to_string();
            let observed = observed_worktrees(&text, &main, &inventory);
            assert!(observed.contains(&inventory[1]), "{key}: {observed:?}");
        }
    }

    #[test]
    fn git_inventory_reports_real_worktrees_and_branches() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let other = dir.path().join("other");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["-c", "user.name=Test", "-c", "user.email=t@example.invalid"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success());
        };
        git(&["init"]);
        git(&["commit", "--allow-empty", "-m", "fixture"]);
        git(&["worktree", "add", "-b", "feature", other.to_str().unwrap()]);
        let all = worktrees(&repo).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|w| w.branch.as_deref() == Some("feature")
            && Path::new(&w.path) == std::fs::canonicalize(&other).unwrap()));
    }
}
