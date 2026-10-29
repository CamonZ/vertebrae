//! Turns two checkpoints into the Git-format patch of what changed between
//! them. Hunks are generated here, never by Git, so recording stays read-only.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use similar::{Algorithm, ChangeTag, TextDiff};

use super::git::{self, CacheBudget, GitError, Limits, MarkerReason, Side, Snapshot};

const BINARY_SNIFF_BYTES: usize = 8 * 1024;
const CONTEXT_LINES: usize = 3;
const MAX_RENAME_PAIRS: usize = 50;
const RENAME_THRESHOLD_PERCENT: u32 = 50;
const DIFF_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct FileMarker {
    pub(crate) reason: MarkerReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct FileEntry {
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) old_path: Option<String>,
    pub(crate) status: FileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) marker: Option<FileMarker>,
}

/// The change between two checkpoints of one worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Delta {
    pub(crate) base_head: Option<String>,
    pub(crate) head_changed: bool,
    pub(crate) patch: String,
    pub(crate) files: Vec<FileEntry>,
}

struct Change {
    path: String,
    old_path: Option<String>,
    similarity: u32,
    before: Side,
    after: Side,
}

impl Change {
    fn status(&self) -> FileStatus {
        if self.old_path.is_some() {
            FileStatus::Renamed
        } else if matches!(self.before, Side::Absent) {
            FileStatus::Added
        } else if matches!(self.after, Side::Absent) {
            FileStatus::Deleted
        } else {
            FileStatus::Modified
        }
    }
}

/// Compare `start` with the worktree as it is now (`end` supplies the dirty
/// paths and HEAD it settled on). A path changed iff its content or mode at
/// the start differs from the file on disk now.
pub(crate) fn compute(
    worktree: &Path,
    start: &Snapshot,
    end: &Snapshot,
    limits: &Limits,
) -> Result<Delta, GitError> {
    let head_changed = start.head != end.head;
    let mut candidates: BTreeSet<String> = start.dirty.keys().cloned().collect();
    candidates.extend(end.dirty.keys().cloned());
    if let (true, Some(from), Some(to)) = (head_changed, &start.head, &end.head) {
        candidates.extend(git::changed_between(worktree, from, to)?);
    }

    let mut budget = CacheBudget::unlimited();
    let after: Vec<(String, Side)> = candidates
        .iter()
        .map(|path| {
            (
                path.clone(),
                git::read_side(worktree, path, limits, &mut budget),
            )
        })
        .collect();

    let clean_at_start: Vec<(String, u32)> = after
        .iter()
        .filter(|(path, _)| !start.dirty.contains_key(path))
        .map(|(path, side)| {
            let known = (!head_changed)
                .then(|| end.dirty.get(path).and_then(|entry| entry.head_mode))
                .flatten();
            (
                path.clone(),
                known.or(side.mode()).unwrap_or(git::DEFAULT_MODE),
            )
        })
        .collect();
    let mut head_sides = match &start.head {
        Some(head) => git::commit_sides(worktree, head, &clean_at_start, limits)?,
        None => Default::default(),
    };

    let mut changes = Vec::new();
    for (path, after) in after {
        let before = match start.files.get(&path) {
            Some(side) if start.dirty.contains_key(&path) => side.clone(),
            _ => head_sides.remove(&path).unwrap_or(Side::Absent),
        };
        if !before.same_as(&after) {
            changes.push(Change {
                path,
                old_path: None,
                similarity: 0,
                before,
                after,
            });
        }
    }
    pair_renames(&mut changes);
    changes.sort_by(|a, b| a.path.cmp(&b.path));

    let (patch, files) = render(&changes, limits);
    Ok(Delta {
        base_head: start.head.clone(),
        head_changed,
        patch,
        files,
    })
}

/// Pair deleted with added paths: identical content first, then the most
/// similar text with at least 50% line similarity, at most 50 pairs.
fn pair_renames(changes: &mut Vec<Change>) {
    let deleted: Vec<usize> = (0..changes.len())
        .filter(|&index| changes[index].status() == FileStatus::Deleted)
        .collect();
    let mut added: Vec<usize> = (0..changes.len())
        .filter(|&index| changes[index].status() == FileStatus::Added)
        .collect();
    let mut pairs: Vec<(usize, usize, u32)> = Vec::new();
    let mut unmatched = Vec::new();
    for &from in &deleted {
        if pairs.len() == MAX_RENAME_PAIRS {
            break;
        }
        let before = &changes[from].before;
        let empty = matches!(before, Side::Content { bytes, .. } if bytes.is_empty());
        match added
            .iter()
            .position(|&to| !empty && before.same_content(&changes[to].after))
        {
            Some(position) => pairs.push((from, added.remove(position), 100)),
            None => unmatched.push(from),
        }
    }
    for from in unmatched {
        if pairs.len() == MAX_RENAME_PAIRS {
            break;
        }
        let Ok(old) = text_of(&changes[from].before) else {
            continue;
        };
        let best = added
            .iter()
            .enumerate()
            .filter_map(|(position, &to)| {
                let new = text_of(&changes[to].after).ok()?;
                let (small, large) = if old.len() < new.len() {
                    (old.len(), new.len())
                } else {
                    (new.len(), old.len())
                };
                if large > 0 && small * 2 < large {
                    return None;
                }
                let score = similarity(old, new);
                (score >= RENAME_THRESHOLD_PERCENT).then_some((position, score))
            })
            .max_by_key(|(_, score)| *score);
        if let Some((position, score)) = best {
            pairs.push((from, added.remove(position), score));
        }
    }

    let mut removed = Vec::new();
    for (from, to, score) in pairs {
        let old_path = changes[from].path.clone();
        let before = std::mem::replace(&mut changes[from].before, Side::Absent);
        let target = &mut changes[to];
        target.old_path = Some(old_path);
        target.similarity = score;
        target.before = before;
        removed.push(from);
    }
    removed.sort_unstable();
    for index in removed.into_iter().rev() {
        changes.remove(index);
    }
}

fn similarity(old: &str, new: &str) -> u32 {
    if old == new {
        return 100;
    }
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .timeout(DIFF_TIMEOUT)
        .diff_lines(old, new);
    (diff.ratio() * 100.0).floor() as u32
}

/// Text of a side, or why it cannot be shown as hunks.
fn text_of(side: &Side) -> Result<&str, MarkerReason> {
    match side {
        Side::Absent => Ok(""),
        Side::Unreadable => Err(MarkerReason::Unreadable),
        Side::Opaque { reason, .. } => Err(*reason),
        Side::Content { bytes, .. } => {
            let sniff = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
            if sniff.contains(&0) {
                return Err(MarkerReason::Binary);
            }
            std::str::from_utf8(bytes).map_err(|_| MarkerReason::Binary)
        }
    }
}

fn render(changes: &[Change], limits: &Limits) -> (String, Vec<FileEntry>) {
    let mut patch = String::new();
    let mut files = Vec::new();
    let mut markers = Vec::new();
    for change in changes {
        let entry = |marker: Option<MarkerReason>| FileEntry {
            path: change.path.clone(),
            old_path: change.old_path.clone(),
            status: change.status(),
            marker: marker.map(|reason| FileMarker { reason }),
        };
        match render_file(change) {
            Ok(text) if patch.len() + text.len() <= limits.patch_bytes => {
                patch.push_str(&text);
                files.push(entry(None));
            }
            Ok(_) => markers.push(entry(Some(MarkerReason::PatchLimit))),
            Err(reason) => markers.push(entry(Some(reason))),
        }
    }
    files.extend(markers);
    (patch, files)
}

fn render_file(change: &Change) -> Result<String, MarkerReason> {
    let same_content = change.before.same_content(&change.after);
    let (old, new) = if same_content {
        ("", "")
    } else {
        // A side over a limit fails first so its reason wins over binary.
        let old = text_of(&change.before);
        let new = text_of(&change.after);
        for side in [&old, &new] {
            if let Err(reason) = side {
                if *reason != MarkerReason::Binary {
                    return Err(*reason);
                }
            }
        }
        (old?, new?)
    };

    let old_path = change.old_path.as_deref().unwrap_or(&change.path);
    let mut text = String::new();
    let _ = writeln!(
        text,
        "diff --git {} {}",
        quote_path("a/", old_path),
        quote_path("b/", &change.path)
    );
    let (old_mode, new_mode) = (change.before.mode(), change.after.mode());
    match change.status() {
        FileStatus::Added => {
            let _ = writeln!(text, "new file mode {:06o}", new_mode.unwrap_or_default());
        }
        FileStatus::Deleted => {
            let _ = writeln!(
                text,
                "deleted file mode {:06o}",
                old_mode.unwrap_or_default()
            );
        }
        FileStatus::Modified | FileStatus::Renamed => {
            if let (Some(old_mode), Some(new_mode)) = (old_mode, new_mode) {
                if old_mode != new_mode {
                    let _ = writeln!(text, "old mode {old_mode:06o}\nnew mode {new_mode:06o}");
                }
            }
            if let Some(from) = &change.old_path {
                let _ = writeln!(
                    text,
                    "similarity index {}%\nrename from {}\nrename to {}",
                    change.similarity,
                    quote_path("", from),
                    quote_path("", &change.path)
                );
            }
        }
    }
    if same_content || old == new {
        return Ok(text);
    }

    let from = if matches!(change.before, Side::Absent) {
        "/dev/null".to_string()
    } else {
        quote_path("a/", old_path)
    };
    let to = if matches!(change.after, Side::Absent) {
        "/dev/null".to_string()
    } else {
        quote_path("b/", &change.path)
    };
    let _ = writeln!(text, "--- {from}\n+++ {to}");
    write_hunks(&mut text, old, new);
    Ok(text)
}

fn write_hunks(text: &mut String, old: &str, new: &str) {
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .timeout(DIFF_TIMEOUT)
        .diff_lines(old, new);
    for group in diff.grouped_ops(CONTEXT_LINES) {
        let Some(first) = group.first() else {
            continue;
        };
        // Hunk lengths are counted from the emitted lines rather than read
        // from the ops' ranges, so the header can never disagree with the body.
        let (mut old_len, mut new_len) = (0, 0);
        let mut body = String::new();
        for op in &group {
            for change in diff.iter_changes(op) {
                let sign = match change.tag() {
                    ChangeTag::Equal => {
                        old_len += 1;
                        new_len += 1;
                        ' '
                    }
                    ChangeTag::Delete => {
                        old_len += 1;
                        '-'
                    }
                    ChangeTag::Insert => {
                        new_len += 1;
                        '+'
                    }
                };
                let value = change.value();
                body.push(sign);
                body.push_str(value);
                if !value.ends_with('\n') {
                    body.push_str("\n\\ No newline at end of file\n");
                }
            }
        }
        let _ = writeln!(
            text,
            "@@ -{} +{} @@",
            hunk_range(first.old_range().start, old_len),
            hunk_range(first.new_range().start, new_len)
        );
        text.push_str(&body);
    }
}

/// Unified range: 1-based start, with the length omitted when it is one and
/// the start naming the preceding line when it is zero.
fn hunk_range(start: usize, length: usize) -> String {
    match length {
        0 => format!("{start},0"),
        1 => format!("{}", start + 1),
        length => format!("{},{length}", start + 1),
    }
}

/// Git's default path quoting (`core.quotePath=true`): C-style escapes and
/// octal for control and non-ASCII bytes, applied to the prefixed path.
fn quote_path(prefix: &str, path: &str) -> String {
    let needs_quotes = path
        .bytes()
        .any(|byte| !(0x20..0x7f).contains(&byte) || byte == b'"' || byte == b'\\');
    if !needs_quotes {
        return format!("{prefix}{path}");
    }
    let mut quoted = format!("\"{prefix}");
    for byte in path.bytes() {
        match byte {
            b'"' => quoted.push_str("\\\""),
            b'\\' => quoted.push_str("\\\\"),
            b'\t' => quoted.push_str("\\t"),
            b'\n' => quoted.push_str("\\n"),
            0x20..=0x7e => quoted.push(byte as char),
            _ => {
                let _ = write!(quoted, "\\{byte:03o}");
            }
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::write_hunks;

    /// Found by the patch round-trip property: the old side lacks a final
    /// newline and the diff's last op is a deletion, which made the new-side
    /// range of the hunk header too short, so `git apply` rejected the patch.
    #[test]
    fn hunk_header_lengths_match_the_body_after_an_unterminated_last_line() {
        let mut text = String::new();
        write_hunks(&mut text, "d\na", "b\n\nd\nc\nd\n");
        assert_eq!(
            text,
            "@@ -1,2 +1,5 @@\n+b\n+\n+d\n+c\n d\n-a\n\\ No newline at end of file\n"
        );
    }
}
