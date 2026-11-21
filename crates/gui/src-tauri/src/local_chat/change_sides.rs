//! Both sides of one changed file for the Changes view, and in semantic
//! mode its semantic diff, computed from those same texts so the webview
//! can check both against the patch at once.
//!
//! Sides are read with the Files sidebar's readers (and path policy). Diffs
//! are cached by the engine version and the sides' revisions: the engine is
//! deterministic, so the same engine, grammar and two texts always give the
//! same answer, whichever comparison asked.

use super::changes::ComparisonSnapshot;
use super::worktree_files::{self, FileBody, FilesError};
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use vertebrae_syntax::semantic::{self, Budget, FallbackReason, SemanticOutcome, ENGINE_VERSION};

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

/// The engine version, a path and both sides' revisions (empty for a
/// missing side).
type Key = (u32, String, String, String);

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
        ENGINE_VERSION,
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

#[derive(serde::Deserialize, specta::Type)]
pub struct ChangedPath {
    pub path: String,
    pub old_path: Option<String>,
}

pub(crate) const GRAPH_TIME: std::time::Duration = std::time::Duration::from_secs(6);

struct GraphSnapshot<'a> {
    snapshot: &'a dyn vertebrae_syntax::intelligence::Snapshot,
    changed: std::collections::HashMap<&'a str, Option<&'a str>>,
    cached: std::cell::RefCell<SourceCache>,
}

#[derive(Default)]
struct SourceCache {
    bytes: usize,
    sources: std::collections::HashMap<String, Option<Arc<str>>>,
}

impl vertebrae_syntax::intelligence::Snapshot for GraphSnapshot<'_> {
    fn paths(&self) -> Result<Vec<String>, vertebrae_syntax::intelligence::SnapshotError> {
        let mut paths = self.snapshot.paths()?;
        paths.retain(|path| !matches!(self.changed.get(path.as_str()), Some(None)));
        paths.extend(
            self.changed
                .iter()
                .filter(|(_, text)| text.is_some())
                .map(|(&path, _)| path.to_owned()),
        );
        paths.sort_unstable();
        paths.dedup();
        Ok(paths)
    }

    fn read(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> Result<Option<String>, vertebrae_syntax::intelligence::SnapshotError> {
        self.read_shared(path, max_bytes)
            .map(|source| source.as_deref().map(str::to_owned))
    }

    fn read_shared(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> Result<Option<Arc<str>>, vertebrae_syntax::intelligence::SnapshotError> {
        if let Some(source) = self.changed.get(path) {
            return Ok(source.filter(|text| text.len() <= max_bytes).map(Arc::from));
        }
        let mut cache = self.cached.borrow_mut();
        if let Some(source) = cache.sources.get(path) {
            return Ok(source
                .as_ref()
                .filter(|text| text.len() <= max_bytes)
                .cloned());
        }
        let limit = vertebrae_syntax::intelligence::Budget::default()
            .max_file_bytes
            .max(max_bytes);
        let source = self.snapshot.read_shared(path, limit)?;
        let bytes = source.as_deref().map_or(0, str::len);
        if cache.bytes + bytes <= CACHE_BYTES && cache.sources.len() < 4_000 {
            cache.bytes += bytes;
            cache.sources.insert(path.to_owned(), source.clone());
        }
        Ok(source.filter(|text| text.len() <= max_bytes))
    }
}

/// Build the comparison graph on a blocking worker, reusing saved semantic diffs.
pub(crate) fn changed_symbols(
    worktree: &Path,
    comparison: &ComparisonSnapshot,
    paths: Vec<ChangedPath>,
) -> Result<
    vertebrae_syntax::changed_symbols::ChangedSymbols,
    super::code_intelligence::CodeIntelligenceError,
> {
    use super::code_intelligence::{self, CodeIntelligenceError, IntelligenceSnapshot};
    use vertebrae_syntax::changed_symbols::{self, ChangedFile};

    let start = std::time::Instant::now();
    let mut budget = vertebrae_syntax::intelligence::Budget {
        time: GRAPH_TIME,
        ..code_intelligence::budget()
    };
    let old = code_intelligence::open_snapshot(
        worktree,
        &IntelligenceSnapshot::Commit {
            commit: comparison.base_commit.clone(),
        },
    )?;
    let target = if comparison.working_tree {
        IntelligenceSnapshot::WorkingTree
    } else {
        IntelligenceSnapshot::Commit {
            commit: comparison.target_commit.clone(),
        }
    };
    let new = code_intelligence::open_snapshot(worktree, &target)?;
    let mut loaded = Vec::new();
    let mut incomplete = false;
    let mut bytes = 0;
    let mut seen = std::collections::HashSet::new();
    for file in &paths {
        if start.elapsed() >= budget.time / 3 || bytes >= CACHE_BYTES {
            incomplete = true;
            break;
        }
        if !seen.insert(&file.path) || vertebrae_syntax::Grammar::for_path(&file.path).is_none() {
            continue;
        }
        let sides = load(
            worktree,
            comparison,
            &file.path,
            file.old_path.as_deref(),
            true,
        )
        .map_err(CodeIntelligenceError::files)?;
        if let (Ok((old, _)), Ok((new, _))) = (text(&sides.old), text(&sides.new)) {
            bytes += old.len() + new.len();
        }
        if !matches!(sides.semantic, Some(SemanticOutcome::Semantic { .. })) {
            incomplete = true;
        }
        loaded.push((file, sides));
    }
    let files: Vec<_> = loaded
        .iter_mut()
        .filter_map(|(file, sides)| {
            let SemanticOutcome::Semantic { declarations, .. } = sides.semantic.take()? else {
                return None;
            };
            let (old, old_revision) = text(&sides.old).ok()?;
            let (new, new_revision) = text(&sides.new).ok()?;
            Some(ChangedFile {
                path: &file.path,
                old_path: file.old_path.as_deref().unwrap_or(&file.path),
                old,
                new,
                old_revision: (!old_revision.is_empty()).then_some(old_revision),
                new_revision: (!new_revision.is_empty()).then_some(new_revision),
                declarations,
            })
        })
        .collect();
    let base = GraphSnapshot {
        snapshot: old.as_ref(),
        changed: files
            .iter()
            .map(|file| (file.old_path, file.old_revision.map(|_| file.old)))
            .collect(),
        cached: Default::default(),
    };
    let target = GraphSnapshot {
        snapshot: new.as_ref(),
        changed: files
            .iter()
            .map(|file| (file.path, file.new_revision.map(|_| file.new)))
            .collect(),
        cached: Default::default(),
    };
    budget.time = budget.time.saturating_sub(start.elapsed());
    let mut graph = changed_symbols::project(
        files,
        code_intelligence::embedded(),
        &base,
        &target,
        &budget,
    );
    graph.incomplete |= incomplete;
    Ok(graph)
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

    const ACCOUNTS: &str = "defmodule Shop.Accounts do\n  def get(id), do: Repo.get(User, id)\n\n  defp audit(entry) do\n    entry\n  end\nend\n";

    /// Labels (`keyword name`, outermost first) and fact kinds of each
    /// changed declaration.
    fn labelled(found: &[DeclarationDiff]) -> Vec<(Vec<String>, Vec<String>)> {
        found
            .iter()
            .map(|d| {
                let labels = d
                    .scope
                    .iter()
                    .chain(&d.subject)
                    .map(|s| format!("{} {}", s.keyword, s.name))
                    .collect();
                let facts = d
                    .facts
                    .items
                    .iter()
                    .chain(d.parts.iter().flat_map(|p| &p.facts().items))
                    .map(|f| serde_json::to_value(f.kind).unwrap()["type"].to_string())
                    .collect();
                (labels, facts)
            })
            .collect()
    }

    #[test]
    fn elixir_worktree_edits_get_declaration_aligned_hunks_with_facts() {
        let (dir, head) = repo();
        let root = dir.path();
        fs::create_dir_all(root.join("lib/shop")).unwrap();
        fs::write(root.join("lib/shop/accounts.ex"), ACCOUNTS).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "elixir"]);
        let head_with_elixir = git(root, &["rev-parse", "HEAD"]);
        assert_ne!(head, head_with_elixir);
        fs::write(
            root.join("lib/shop/accounts.ex"),
            ACCOUNTS.replace("    entry\n", "    File.write!(\"audit.log\", entry)\n"),
        )
        .unwrap();
        let sides = working_tree(root, &head_with_elixir, "lib/shop/accounts.ex").unwrap();
        let found = declarations(outcome(sides));
        assert_eq!(
            labelled(&found),
            [(
                vec![
                    "defmodule Shop.Accounts".to_owned(),
                    "defp audit".to_owned()
                ],
                vec!["\"effect\"".to_owned(), "\"unwrap\"".to_owned()],
            )],
            "{found:#?}"
        );
        // The hunks are the function's changed line, not the whole file.
        for part in &found[0].parts {
            let (old, new) = part.spans();
            for span in old.into_iter().chain(new) {
                assert_eq!((span.start, span.end), (5, 5), "{found:#?}");
            }
        }
    }

    #[test]
    fn elixir_scripts_in_commits_and_broken_files_take_their_paths() {
        let (dir, base) = repo();
        let root = dir.path();
        fs::create_dir_all(root.join("test")).unwrap();
        let script = "defmodule Shop.AccountsTest do\n  use ExUnit.Case\n\n  test \"gets\" do\n    assert get(1) == 1\n  end\nend\n";
        fs::write(root.join("test/accounts_test.exs"), script).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "test"]);
        let first = git(root, &["rev-parse", "HEAD"]);
        fs::write(
            root.join("test/accounts_test.exs"),
            script.replace("== 1", "== 2"),
        )
        .unwrap();
        git(root, &["commit", "-qam", "edit"]);
        let second = git(root, &["rev-parse", "HEAD"]);
        let sides = load(
            root,
            &comparison(&first, &second, false),
            "test/accounts_test.exs",
            None,
            true,
        )
        .unwrap();
        let found = declarations(outcome(sides));
        assert_eq!(
            labelled(&found),
            [(
                vec!["defmodule Shop.AccountsTest".to_owned()],
                vec!["\"literal\"".to_owned(), "\"test_code\"".to_owned()],
            )],
            "{found:#?}"
        );
        // A side that does not parse falls back to the line diff.
        fs::write(
            root.join("test/accounts_test.exs"),
            script.replace("get(1) == 1", "get(1 == 1"),
        )
        .unwrap();
        assert_eq!(
            outcome(working_tree(root, &base, "test/accounts_test.exs").unwrap()),
            SemanticOutcome::Fallback {
                reason: FallbackReason::SyntaxError
            }
        );
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
