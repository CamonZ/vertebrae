use super::{invalid, AssociationWorktree, CommandError};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use vertebrae_sacrum_client::VertebraeConfigFile;

pub(super) struct Scope {
    pub root: PathBuf,
    project_root: PathBuf,
    /// Registered project the conversation root belongs to.
    pub project: String,
    pub config: VertebraeConfigFile,
    pub worktrees: Vec<AssociationWorktree>,
}

const GIT_OUTPUT_LIMIT: u64 = 256_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const DIRECTORY_ENTRY_LIMIT: usize = 512;
const WORKTREE_LIMIT: usize = 1024;

impl Scope {
    pub(super) fn owns_cache_root(&self, root: &Path) -> bool {
        root == self.project_root || self.worktrees.iter().any(|w| Path::new(&w.path) == root)
    }
}

/// Bounded `git worktree list`: output is capped while reading and a stuck
/// process is killed and reaped at the deadline. Blocking; call from a blocking context.
fn git_worktree_list(root: &Path, deadline: Instant) -> Result<Vec<u8>, CommandError> {
    let unavailable = || invalid("Git worktree inventory is unavailable.");
    if Instant::now() >= deadline {
        return Err(unavailable());
    }
    let mut command = Command::new("git");
    // A caller's Git environment must not redirect this read-only inventory.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let mut child = command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
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
    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(Ok(buffer)) if buffer.len() as u64 <= GIT_OUTPUT_LIMIT => loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return if status.success() {
                        Ok(buffer)
                    } else {
                        Err(unavailable())
                    }
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(unavailable());
                }
            }
        },
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Err(unavailable())
        }
    }
}

fn worktrees(root: &Path, deadline: Instant) -> Result<Vec<AssociationWorktree>, CommandError> {
    let stdout = git_worktree_list(root, deadline)?;
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

/// Registered local workspaces are trusted directories, not a sandbox against
/// concurrent hostile filesystem changes. Discovery is shallow and bounded;
/// child symlinks and linked checkouts of foreign repositories are not roots.
fn project_worktrees(
    project_root: &Path,
    registered: &[(String, PathBuf)],
    deadline: Instant,
) -> Result<Vec<AssociationWorktree>, CommandError> {
    if project_root.join(".git").exists() {
        return worktrees(project_root, deadline);
    }
    let unavailable = || invalid("Project repository inventory is unavailable.");
    let children = std::fs::read_dir(project_root)
        .map_err(|_| unavailable())?
        .take(DIRECTORY_ENTRY_LIMIT + 1)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| unavailable())?;
    if children.len() > DIRECTORY_ENTRY_LIMIT {
        return Err(invalid(
            "Project directory exceeds the repository discovery limit.",
        ));
    }
    let mut repositories = vec![];
    for child in children {
        if !child.file_type().map_err(|_| unavailable())?.is_dir() {
            continue;
        }
        let path = child.path();
        // Owned primary repositories have a .git directory. A .git file may
        // belong to a repository registered elsewhere (e.g. a sibling project).
        let primary =
            std::fs::symlink_metadata(path.join(".git")).is_ok_and(|metadata| metadata.is_dir());
        if !primary {
            continue;
        }
        let path = std::fs::canonicalize(path).map_err(|_| unavailable())?;
        if registered.iter().any(|(_, other)| {
            other != project_root && other.starts_with(project_root) && path.starts_with(other)
        }) {
            continue;
        }
        repositories.push(path);
    }
    repositories.sort();
    let mut seen = HashSet::new();
    let mut entries = vec![];
    for repository in repositories {
        for entry in worktrees(&repository, deadline)? {
            if seen.insert(entry.path.clone()) {
                entries.push(entry);
            }
            if entries.len() > WORKTREE_LIMIT {
                return Err(invalid("Project exceeds the worktree discovery limit."));
            }
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Resolve the conversation against registered project containers and their
/// actual Git worktrees. More-specific registrations own their own repositories.
pub(super) fn scope(root: &str) -> Result<Scope, CommandError> {
    let root = std::fs::canonicalize(root)
        .map_err(|_| invalid("Conversation workspace is unavailable."))?;
    let config = vertebrae_sacrum_client::load_config_file()
        .map_err(|_| invalid("Could not read shared settings."))?;
    scope_with_config(root, config)
}

fn scope_with_config(root: PathBuf, config: VertebraeConfigFile) -> Result<Scope, CommandError> {
    let mut registered: Vec<_> = config
        .projects
        .iter()
        .filter_map(|(slug, project)| {
            std::fs::canonicalize(&project.path)
                .ok()
                .map(|path| (slug.clone(), path))
        })
        .collect();
    registered.sort_by_key(|(_, path)| {
        (
            !root.starts_with(path),
            std::cmp::Reverse(path.components().count()),
        )
    });
    // One deadline covers all Git commands, not five seconds per repository.
    let deadline = Instant::now() + GIT_TIMEOUT;
    for (slug, project_root) in &registered {
        let entries = project_worktrees(project_root, &registered, deadline);
        if root == *project_root {
            return Ok(Scope {
                root,
                project_root: project_root.clone(),
                project: slug.clone(),
                worktrees: entries?,
                config,
            });
        }
        if let Ok(entries) = entries {
            if entries.iter().any(|w| Path::new(&w.path) == root) {
                return Ok(Scope {
                    root,
                    project_root: project_root.clone(),
                    project: slug.clone(),
                    worktrees: entries,
                    config,
                });
            }
        }
        if Instant::now() >= deadline {
            return Err(invalid("Project repository inventory timed out."));
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
        let all = worktrees(&repo, Instant::now() + GIT_TIMEOUT).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|w| w.branch.as_deref() == Some("feature")
            && Path::new(&w.path) == std::fs::canonicalize(&other).unwrap()));
    }

    fn fixture_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn fixture_repo(path: &Path) -> PathBuf {
        std::fs::create_dir_all(path).unwrap();
        fixture_git(path, &["init"]);
        fixture_git(path, &["commit", "--allow-empty", "-m", "fixture"]);
        std::fs::canonicalize(path).unwrap()
    }

    fn register(config: &mut VertebraeConfigFile, slug: &str, path: &Path) {
        config.projects.insert(
            slug.into(),
            vertebrae_sacrum_client::ProjectSection {
                id: "unused-in-inventory-test".into(),
                path: path.to_string_lossy().into(),
            },
        );
    }

    #[test]
    fn project_container_discovers_child_repositories_and_a_later_created_worktree() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let repo = fixture_repo(&root.join("market_processor"));
        let other_repo = fixture_repo(&root.join("trade_gym"));
        let mut config = VertebraeConfigFile::default();
        register(&mut config, "tradebananas", &root);
        let before = scope_with_config(root.clone(), config.clone()).unwrap();
        assert_eq!(before.project, "tradebananas");
        assert_eq!(before.root, root);
        assert_eq!(before.worktrees.len(), 2);
        assert!(before.owns_cache_root(&root));
        assert!(before.owns_cache_root(&other_repo));
        assert!(!before.owns_cache_root(&root.join("unregistered")));

        let created = root.join("market_processor-f6f6bf5e");
        fixture_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "fix/f6f6bf5e",
                created.to_str().unwrap(),
            ],
        );
        let after = scope_with_config(root.clone(), config.clone()).unwrap();
        let touched = observed_worktrees(
            &serde_json::json!({"cwd": created, "cmd": "cargo test"}).to_string(),
            &after.root,
            &after.worktrees,
        );
        assert_eq!(touched.len(), 1);
        assert_eq!(Path::new(&touched[0].path), created);
        assert_eq!(touched[0].branch.as_deref(), Some("fix/f6f6bf5e"));
        assert!(!before.worktrees.contains(&touched[0]));
        let from_worktree = scope_with_config(created.clone(), config).unwrap();
        assert_eq!(from_worktree.project, "tradebananas");
        assert!(from_worktree.owns_cache_root(&root));
        assert_eq!(from_worktree.worktrees, after.worktrees);
    }

    #[test]
    fn container_does_not_claim_a_foreign_repositorys_linked_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let owned = fixture_repo(&root.join("market_processor"));
        let foreign = fixture_repo(&temp.path().join("foreign"));
        let linked = root.join("foreign-worktree");
        fixture_git(
            &foreign,
            &["worktree", "add", "-b", "foreign", linked.to_str().unwrap()],
        );
        let root = std::fs::canonicalize(root).unwrap();
        let mut config = VertebraeConfigFile::default();
        register(&mut config, "container", &root);
        register(&mut config, "foreign", &foreign);
        let scope = scope_with_config(root.clone(), config.clone()).unwrap();
        assert_eq!(scope.worktrees.len(), 1);
        assert_eq!(Path::new(&scope.worktrees[0].path), owned);
        assert!(!scope.owns_cache_root(&foreign));
        assert!(!scope.owns_cache_root(&linked));
        assert!(observed_worktrees(linked.to_str().unwrap(), &root, &scope.worktrees).is_empty());
        assert_eq!(
            scope_with_config(std::fs::canonicalize(linked).unwrap(), config)
                .unwrap()
                .project,
            "foreign"
        );
    }

    #[test]
    fn separately_registered_child_project_keeps_its_own_scope_and_cache() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let child = fixture_repo(&root.join("child"));
        let mut config = VertebraeConfigFile::default();
        register(&mut config, "parent", &root);
        register(&mut config, "child", &child);
        let parent = scope_with_config(root.clone(), config.clone()).unwrap();
        assert!(parent.worktrees.is_empty());
        assert!(parent.owns_cache_root(&root));
        assert!(!parent.owns_cache_root(&child));
        let scope = scope_with_config(child.clone(), config).unwrap();
        assert_eq!(scope.project, "child");
        assert!(scope.owns_cache_root(&child));
        assert!(!scope.owns_cache_root(&root));
    }

    #[cfg(unix)]
    #[test]
    fn container_discovery_does_not_follow_child_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let foreign = fixture_repo(&temp.path().join("foreign"));
        std::os::unix::fs::symlink(&foreign, root.join("alias")).unwrap();
        let mut config = VertebraeConfigFile::default();
        register(&mut config, "container", &root);
        assert!(scope_with_config(root, config.clone())
            .unwrap()
            .worktrees
            .is_empty());
        assert!(scope_with_config(foreign, config).is_err());
    }

    #[test]
    fn container_discovery_rejects_an_incomplete_directory_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        for index in 0..=DIRECTORY_ENTRY_LIMIT {
            std::fs::write(root.join(index.to_string()), "").unwrap();
        }
        let mut config = VertebraeConfigFile::default();
        register(&mut config, "container", &root);
        assert!(scope_with_config(root, config).is_err());
    }
}
