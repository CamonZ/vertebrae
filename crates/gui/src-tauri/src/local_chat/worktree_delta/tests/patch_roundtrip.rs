//! Round-trip property of the recorded patch: applying `compute(A, B)` to a
//! copy of state A with `git apply` must reproduce state B, for every file the
//! patch does not mark as undisplayable. `git apply` is the independent
//! oracle; nothing here reimplements the patch writer.

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::process::Stdio;

use hegel::generators as gs;
use hegel::TestCase;

use super::*;

/// Few paths, so renames, overwrites and re-creations collide often. Includes
/// committed files, a nested directory, a space, a non-ASCII name and a quote.
const PATHS: [&str; 9] = [
    "edit.txt",
    "remove.txt",
    "move.txt",
    "new.txt",
    "dir/b.txt",
    "dir/sub/c.txt",
    "with space.txt",
    "é.txt",
    "q\"uote.txt",
];

#[derive(Debug, Clone)]
enum FsOp {
    Write(&'static str, Vec<u8>),
    Delete(&'static str),
    Rename(&'static str, &'static str),
    ToggleExecutable(&'static str),
}

fn draw_path(tc: &TestCase) -> &'static str {
    PATHS[tc.draw(gs::integers::<usize>().max_value(PATHS.len() - 1))]
}

fn draw_content(tc: &TestCase) -> Vec<u8> {
    if tc.draw(gs::weighted_booleans(0.05)) {
        return b"bin\0ary\n".to_vec();
    }
    let lines = tc.draw(
        gs::vecs(gs::sampled_from(vec![
            "a", "b", "c", "d", "", " x", "tab\t", "cr\r",
        ]))
        .max_size(6),
    );
    let mut text = lines.join("\n");
    if tc.draw(gs::booleans()) {
        text.push('\n');
    }
    text.into_bytes()
}

/// A path that exists now (when any does) or, for creations, any path.
fn draw_existing_or_any(tc: &TestCase, root: &Path) -> &'static str {
    let existing: Vec<&'static str> = PATHS
        .iter()
        .copied()
        .filter(|path| root.join(path).is_file())
        .collect();
    if existing.is_empty() || tc.draw(gs::weighted_booleans(0.2)) {
        draw_path(tc)
    } else {
        existing[tc.draw(gs::integers::<usize>().max_value(existing.len() - 1))]
    }
}

/// Draw and apply up to `max` operations one at a time, so that deletions,
/// renames and mode changes mostly target files that exist.
fn run_ops(tc: &TestCase, root: &Path, max: usize, label: &str) {
    let count = tc.draw(gs::integers::<usize>().max_value(max));
    for _ in 0..count {
        let op = match tc.draw(gs::integers::<u8>().max_value(3)) {
            0 => FsOp::Write(draw_existing_or_any(tc, root), draw_content(tc)),
            1 => FsOp::Delete(draw_existing_or_any(tc, root)),
            2 => FsOp::Rename(draw_existing_or_any(tc, root), draw_path(tc)),
            _ => FsOp::ToggleExecutable(draw_existing_or_any(tc, root)),
        };
        tc.note(&format!("{label}: {op:?}"));
        apply(root, &op);
    }
}

fn apply(root: &Path, op: &FsOp) {
    match op {
        FsOp::Write(path, content) => {
            let existing = std::fs::metadata(root.join(path)).ok();
            write(root, path, content);
            if let Some(meta) = existing {
                let _ = std::fs::set_permissions(root.join(path), meta.permissions());
            }
        }
        FsOp::Delete(path) => {
            let _ = std::fs::remove_file(root.join(path));
        }
        FsOp::Rename(from, to) => {
            if from != to && root.join(from).is_file() {
                if let Some(parent) = root.join(to).parent() {
                    std::fs::create_dir_all(parent).unwrap();
                }
                std::fs::rename(root.join(from), root.join(to)).unwrap();
            }
        }
        FsOp::ToggleExecutable(path) => {
            if let Ok(meta) = std::fs::metadata(root.join(path)) {
                let mut permissions = meta.permissions();
                permissions.set_mode(permissions.mode() ^ 0o111);
                std::fs::set_permissions(root.join(path), permissions).unwrap();
            }
        }
    }
}

/// Every file outside `.git` with its bytes and executable bit.
fn tree(root: &Path) -> BTreeMap<String, (Vec<u8>, bool)> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, (Vec<u8>, bool)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|name| name == ".git") {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                let executable = path.metadata().unwrap().permissions().mode() & 0o100 != 0;
                out.insert(relative, (std::fs::read(&path).unwrap(), executable));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn copy_dir(from: &Path, to: &Path) {
    let status = Command::new("cp")
        .arg("-Rp")
        .arg(from)
        .arg(to)
        .status()
        .unwrap();
    assert!(status.success());
}

fn git_apply(root: &Path, patch: &str) -> Result<(), String> {
    use std::io::Write;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["apply", "--whitespace=nowarn", "-"])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(patch.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

#[hegel::test(test_cases = 40)]
fn applying_the_recorded_patch_to_the_start_state_reproduces_the_end_state(tc: TestCase) {
    let (_repo, worktree) = repo();
    run_ops(&tc, &worktree, 6, "before");
    let limits = git::Limits::default();
    let start = git::snapshot(&worktree, &limits).unwrap();
    let scratch = TempDir::new().unwrap();
    let start_copy = scratch.path().join("start");
    copy_dir(&worktree, &start_copy);

    run_ops(&tc, &worktree, 6, "tool");
    let end = git::snapshot(&worktree, &limits).unwrap();
    let delta = patch::compute(&worktree, &start, &end, &limits).unwrap();

    if delta.patch.is_empty() {
        // Nothing displayable changed.
    } else if let Err(error) = git_apply(&start_copy, &delta.patch) {
        panic!(
            "git apply rejected the patch: {error}\n--- patch ---\n{}",
            delta.patch
        );
    }

    let skipped: Vec<&str> = delta
        .files
        .iter()
        .filter(|file| file.marker.is_some())
        .flat_map(|file| std::iter::once(file.path.as_str()).chain(file.old_path.as_deref()))
        .collect();
    let (rebuilt, actual) = (tree(&start_copy), tree(&worktree));
    let paths: std::collections::BTreeSet<_> = rebuilt.keys().chain(actual.keys()).collect();
    for path in paths {
        if skipped.contains(&path.as_str()) {
            continue;
        }
        assert_eq!(
            rebuilt.get(path),
            actual.get(path),
            "{path} differs after applying the patch\n--- patch ---\n{}",
            delta.patch
        );
    }
}
