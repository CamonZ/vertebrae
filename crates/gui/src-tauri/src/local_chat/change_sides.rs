//! Both sides of one changed file for the Changes view, and in semantic
//! mode its semantic diff, computed from those same texts so the webview
//! can check both against the patch at once.
//!
//! Sides are read with the Files sidebar's readers (and path policy). Diffs
//! are cached by the sides' revisions: the engine is deterministic, so the
//! same grammar and two texts always give the same answer, whichever
//! comparison asked.

use super::changes::ComparisonSnapshot;
use super::worktree_files::{self, FileBody, FilesError};
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use vertebrae_syntax::semantic::{self, Budget, FallbackReason, SemanticOutcome};

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct ChangeSides {
    pub old: FileBody,
    pub new: FileBody,
    /// In semantic mode only.
    pub semantic: Option<SemanticOutcome>,
}

/// Cached results past either limit evict the oldest first.
const CACHE_ENTRIES: usize = 512;
const CACHE_BYTES: usize = 16 * 1024 * 1024;

/// A path and both sides' revisions (empty for a missing side).
type Key = (String, String, String);

/// Oldest-first eviction. Concurrent misses for one key compute twice and
/// store the same value; that costs time, never correctness.
struct Cache {
    entries: BTreeMap<Key, (Arc<SemanticOutcome>, usize)>,
    order: VecDeque<Key>,
    bytes: usize,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache {
    entries: BTreeMap::new(),
    order: VecDeque::new(),
    bytes: 0,
});

/// Stores a result weighed by its input size, which bounds its own.
fn store(key: Key, value: Arc<SemanticOutcome>, size: usize) {
    let Ok(mut cache) = CACHE.lock() else { return };
    if let Some((_, replaced)) = cache.entries.insert(key.clone(), (value, size)) {
        cache.bytes -= replaced;
    } else {
        cache.order.push_back(key);
    }
    cache.bytes += size;
    while cache.order.len() > CACHE_ENTRIES || cache.bytes > CACHE_BYTES {
        let Some(oldest) = cache.order.pop_front() else {
            break;
        };
        if let Some((_, size)) = cache.entries.remove(&oldest) {
            cache.bytes -= size;
        }
    }
}

/// A side's text and revision, or why it has none. A missing side (an
/// added or deleted file) is empty, so its declarations read as added or
/// removed.
fn text(body: &FileBody) -> Result<(&str, &str), FallbackReason> {
    match body {
        FileBody::Text { contents, revision } => Ok((contents, revision)),
        FileBody::Missing => Ok(("", "")),
        FileBody::TooLarge => Err(FallbackReason::TooLarge),
        FileBody::Binary | FileBody::Unreadable { .. } => Err(FallbackReason::NotText),
    }
}

fn diff(path: &str, old: &FileBody, new: &FileBody) -> Arc<SemanticOutcome> {
    let ((old, old_revision), (new, new_revision)) = match (text(old), text(new)) {
        (Ok(old), Ok(new)) => (old, new),
        (Err(reason), _) | (_, Err(reason)) => {
            return Arc::new(SemanticOutcome::Fallback { reason });
        }
    };
    let key = (
        path.to_owned(),
        old_revision.to_owned(),
        new_revision.to_owned(),
    );
    let hit = CACHE
        .lock()
        .ok()
        .and_then(|cache| Some(cache.entries.get(&key)?.0.clone()));
    if let Some(hit) = hit {
        return hit;
    }
    let value = Arc::new(semantic::diff(path, old, new, &Budget::default()));
    // A timeout depends on load, not content: retry it next time.
    if !matches!(
        *value,
        SemanticOutcome::Fallback {
            reason: FallbackReason::TimedOut
        }
    ) {
        store(key, value.clone(), old.len() + new.len());
    }
    value
}

/// Both sides of `path` in `comparison` (`old_path` on the base side of a
/// rename), plus their semantic diff when asked. Errors when a path is
/// refused or the repository cannot be read.
pub(crate) fn load(
    worktree: &Path,
    comparison: &ComparisonSnapshot,
    path: &str,
    old_path: Option<&str>,
    semantic: bool,
) -> Result<ChangeSides, FilesError> {
    let old =
        worktree_files::read_commit(worktree, old_path.unwrap_or(path), &comparison.base_commit)?;
    let new = if comparison.working_tree {
        worktree_files::read_file(worktree, path)?
    } else {
        worktree_files::read_commit(worktree, path, &comparison.target_commit)?
    };
    let semantic = semantic.then(|| diff(path, &old, &new).as_ref().clone());
    Ok(ChangeSides { old, new, semantic })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use vertebrae_syntax::semantic::{DeclarationChange, DeclarationDiff};

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "test@example.invalid"]);
        git(root, &["config", "user.name", "Test"]);
        fs::write(root.join("lib.rs"), "fn a() -> u8 {\n    1\n}\n").unwrap();
        fs::write(root.join("notes.md"), "# Notes\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "base"]);
        let head = git(root, &["rev-parse", "HEAD"]);
        (dir, head)
    }

    fn comparison(base: &str, target: &str, working_tree: bool) -> ComparisonSnapshot {
        ComparisonSnapshot {
            base_commit: base.into(),
            selected_base_commit: base.into(),
            target_commit: target.into(),
            working_tree,
            merge_base: false,
        }
    }

    fn working_tree(dir: &Path, head: &str, path: &str) -> Result<ChangeSides, FilesError> {
        load(dir, &comparison(head, head, true), path, None, true)
    }

    fn outcome(sides: ChangeSides) -> SemanticOutcome {
        sides.semantic.expect("asked for the semantic diff")
    }

    fn declarations(outcome: SemanticOutcome) -> Vec<DeclarationDiff> {
        match outcome {
            SemanticOutcome::Semantic { declarations, .. } => declarations,
            other => panic!("expected a semantic diff: {other:?}"),
        }
    }

    #[test]
    fn working_tree_edits_get_both_sides_and_their_diff() {
        let (dir, head) = repo();
        fs::write(dir.path().join("lib.rs"), "fn a() -> u8 {\n    2\n}\n").unwrap();
        let sides = working_tree(dir.path(), &head, "lib.rs").unwrap();
        assert!(matches!(&sides.old, FileBody::Text { contents, .. } if contents.contains('1')));
        assert!(matches!(&sides.new, FileBody::Text { contents, .. } if contents.contains('2')));
        let found = declarations(outcome(sides));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].subject.as_ref().unwrap().name, "a");
    }

    #[test]
    fn line_mode_reads_the_sides_only() {
        let (dir, head) = repo();
        let sides = load(
            dir.path(),
            &comparison(&head, &head, true),
            "lib.rs",
            None,
            false,
        );
        assert!(sides.unwrap().semantic.is_none());
    }

    #[test]
    fn a_binary_side_is_not_text() {
        let (dir, head) = repo();
        fs::write(dir.path().join("blob.rs"), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(
            outcome(working_tree(dir.path(), &head, "blob.rs").unwrap()),
            SemanticOutcome::Fallback {
                reason: FallbackReason::NotText
            }
        );
    }

    #[test]
    fn sides_past_the_size_limit_are_too_large() {
        let (dir, head) = repo();
        let big = "fn a() {}\n".repeat(Budget::default().max_bytes / 10 + 1);
        fs::write(dir.path().join("lib.rs"), big).unwrap();
        assert_eq!(
            outcome(working_tree(dir.path(), &head, "lib.rs").unwrap()),
            SemanticOutcome::Fallback {
                reason: FallbackReason::TooLarge
            }
        );
    }

    #[test]
    fn a_rename_source_outside_the_worktree_is_refused() {
        // The new side's path policy is `worktree_files`' own; the base side
        // of a rename is read from a commit with the same policy.
        let (dir, head) = repo();
        let all = comparison(&head, &head, true);
        for path in [
            "/etc/passwd",
            "../secret.rs",
            "src/../../secret.rs",
            ".git/config",
        ] {
            let renamed = load(dir.path(), &all, "lib.rs", Some(path), true);
            assert!(renamed.is_err(), "{path} was read");
        }
        // A subdirectory is not a worktree.
        fs::create_dir(dir.path().join("src")).unwrap();
        assert!(working_tree(&dir.path().join("src"), &head, "lib.rs").is_err());
    }

    #[test]
    fn added_and_deleted_files_diff_against_an_empty_side() {
        let (dir, head) = repo();
        fs::write(dir.path().join("new.rs"), "fn b() {}\n").unwrap();
        fs::remove_file(dir.path().join("lib.rs")).unwrap();
        let whole = |path: &str| {
            declarations(outcome(working_tree(dir.path(), &head, path).unwrap()))
                .into_iter()
                .map(|d| (d.change.spans(), d.subject.unwrap().name))
                .collect::<Vec<_>>()
        };
        let [(spans, name)] = &whole("new.rs")[..] else {
            panic!("one added function");
        };
        assert_eq!((spans.0, name.as_str()), (None, "b"));
        let [(spans, name)] = &whole("lib.rs")[..] else {
            panic!("one removed function");
        };
        assert_eq!((spans.1, name.as_str()), (None, "a"));
    }

    #[test]
    fn committed_targets_and_renames_read_both_commits() {
        let (dir, base) = repo();
        let root = dir.path();
        git(root, &["mv", "lib.rs", "core.rs"]);
        fs::write(
            root.join("core.rs"),
            "fn a() -> u8 {\n    1\n}\n\nfn b() {}\n",
        )
        .unwrap();
        git(root, &["commit", "-qam", "move"]);
        let target = git(root, &["rev-parse", "HEAD"]);
        let sides = load(
            root,
            &comparison(&base, &target, false),
            "core.rs",
            Some("lib.rs"),
            true,
        )
        .unwrap();
        let found = declarations(outcome(sides));
        assert_eq!(found.len(), 1);
        assert!(matches!(found[0].change, DeclarationChange::Added { .. }));
    }

    #[test]
    fn results_are_cached_by_revision() {
        let body = |text: &str, revision: &str| FileBody::Text {
            contents: text.into(),
            revision: revision.into(),
        };
        let (x, y) = (
            body("fn x() {}\n", "cache-x"),
            body("fn y() {}\n", "cache-y"),
        );
        let first = diff("cache_probe.rs", &x, &y);
        let second = diff("cache_probe.rs", &x, &y);
        assert!(Arc::ptr_eq(&first, &second));
        let z = body("fn z() {}\n", "cache-z");
        assert!(!Arc::ptr_eq(&first, &diff("cache_probe.rs", &x, &z)));
    }
}
