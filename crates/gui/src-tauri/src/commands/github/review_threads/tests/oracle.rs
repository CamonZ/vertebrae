//! Placement against an oracle that tracks each published line through
//! generated local edits, without diffing text.

use super::*;
use hegel::generators as gs;
use std::collections::BTreeMap;

const PATH: &str = "demo.txt";

/// A commit of exactly `contents` at [`PATH`] (no file for `None`).
fn commit_of(repo: &Repository, contents: Option<&[u8]>, parents: &[Oid], head: bool) -> Oid {
    let mut tree = repo.treebuilder(None).unwrap();
    if let Some(contents) = contents {
        let blob = repo.blob(contents).unwrap();
        tree.insert(PATH, blob, 0o100644).unwrap();
    }
    let tree = repo.find_tree(tree.write().unwrap()).unwrap();
    let parents: Vec<_> = parents
        .iter()
        .map(|id| repo.find_commit(*id).unwrap())
        .collect();
    let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
    repo.commit(
        head.then_some("HEAD"),
        &sig,
        &sig,
        "fixture",
        &tree,
        &parents.iter().collect::<Vec<_>>(),
    )
    .unwrap()
}

enum Mode {
    Shown,
    /// The shown side has no such file.
    Absent,
    /// The published commit is not in this clone.
    Unfetched,
}

struct Range {
    start: u32,
    end: u32,
    /// Reaches past the published file.
    invalid: bool,
}

/// Every line of a range that survives the edits unchanged and contiguous
/// is anchored at its new place; any edit inside it leaves the thread at its
/// published range with the published text. Repeated lines may let the diff
/// align differently, so there only what is placed is checked: an anchor
/// always covers identical text. A missing commit is unverified, a range
/// past the file is an invalid anchor, an absent file is not shown.
#[hegel::test(test_cases = 60)]
fn placement_follows_published_lines_through_local_edits(tc: hegel::TestCase) {
    let count = tc.draw(gs::integers::<usize>().min_value(3).max_value(12));
    let repeats = tc.draw(gs::booleans());
    let ending = if tc.draw(gs::booleans()) {
        "\r\n"
    } else {
        "\n"
    };
    let trailing_newline = tc.draw(gs::booleans());
    let texts: Vec<String> = (0..count)
        .map(|index| {
            if repeats {
                format!("w{}", tc.draw(gs::integers::<u8>().max_value(2)))
            } else {
                format!("line-{index}")
            }
        })
        .collect();
    let end_of = |index: usize| {
        if index + 1 == count && !trailing_newline {
            ""
        } else {
            ending
        }
    };
    let published: String = texts
        .iter()
        .enumerate()
        .map(|(index, text)| format!("{text}{}", end_of(index)))
        .collect();

    // Up to three edits on distinct lines: insert before, delete, rewrite.
    let edit_count = tc.draw(gs::integers::<usize>().max_value(3));
    let mut edits = BTreeMap::new();
    let mut candidates: Vec<_> = (0..count).collect();
    for _ in 0..edit_count {
        let index = tc.draw(gs::integers::<usize>().max_value(candidates.len() - 1));
        edits.insert(
            candidates.swap_remove(index),
            tc.draw(gs::integers::<u8>().max_value(2)),
        );
    }
    let mut current = String::new();
    // Where each surviving published line (0-based) sits now (1-based).
    let mut now_at: BTreeMap<usize, u32> = BTreeMap::new();
    let mut lines = 0_u32;
    for (index, text) in texts.iter().enumerate() {
        match edits.get(&index) {
            Some(0) => {
                current.push_str(&format!("inserted-{index}{ending}"));
                lines += 1;
            }
            Some(1) => continue,
            Some(2) => {
                current.push_str(&format!("edited-{index}{}", end_of(index)));
                lines += 1;
                continue;
            }
            _ => {}
        }
        lines += 1;
        now_at.insert(index, lines);
        current.push_str(&format!("{text}{}", end_of(index)));
    }

    let mode = match tc.draw(gs::integers::<u8>().max_value(9)) {
        0 => Mode::Absent,
        1 => Mode::Unfetched,
        _ => Mode::Shown,
    };
    let side = if tc.draw(gs::booleans()) {
        ReviewThreadSide::Left
    } else {
        ReviewThreadSide::Right
    };
    let ranges: Vec<Range> = (0..tc.draw(gs::integers::<usize>().min_value(1).max_value(3)))
        .map(|_| {
            let start = tc.draw(gs::integers::<usize>().min_value(1).max_value(count));
            let end = tc.draw(
                gs::integers::<usize>()
                    .min_value(start)
                    .max_value(count.min(start + 3)),
            );
            let invalid = tc.draw(gs::integers::<u8>().max_value(9)) == 0;
            let end = if invalid {
                count + 1 + tc.draw(gs::integers::<usize>().max_value(2))
            } else {
                end
            };
            Range {
                start: start as u32,
                end: end as u32,
                invalid,
            }
        })
        .collect();

    let dir = tempfile::tempdir().unwrap();
    let repo = init(dir.path());
    let shown = (!matches!(mode, Mode::Absent)).then_some(current.as_bytes());
    let unknown = Oid::from_str("1111111111111111111111111111111111111111").unwrap();
    let mut request = match side {
        ReviewThreadSide::Right => {
            let head = commit_of(&repo, Some(published.as_bytes()), &[], true);
            if let Some(bytes) = shown {
                std::fs::write(dir.path().join(PATH), bytes).unwrap();
            }
            request(head, Vec::new())
        }
        ReviewThreadSide::Left => {
            let base = commit_of(&repo, Some(published.as_bytes()), &[], true);
            let head = commit_of(&repo, Some(b"fn head() {}\n"), &[base], true);
            let shown_base = commit_of(&repo, shown, &[base], false);
            let mut request = request(head, Vec::new());
            request.base_oid = base.to_string();
            request.shown_base = shown_base.to_string();
            request
        }
    };
    if matches!(mode, Mode::Unfetched) {
        match side {
            ReviewThreadSide::Right => request.head_oid = unknown.to_string(),
            ReviewThreadSide::Left => request.base_oid = unknown.to_string(),
        }
    }
    request.threads = ranges
        .iter()
        .enumerate()
        .map(|(index, range)| {
            thread(
                &format!("T{index}"),
                GithubThreadAnchor {
                    path: PATH.into(),
                    side,
                    start_line: Some(range.start),
                    ..anchor(Some(range.end))
                },
            )
        })
        .collect();

    let line_text = |text: &str, number: u32| -> String {
        text.split_inclusive('\n')
            .nth(number as usize - 1)
            .unwrap()
            .to_owned()
    };
    for (range, placement) in ranges.iter().zip(placements(&repo, &request)) {
        let (start, end) = (range.start, range.end);
        let expected = match mode {
            Mode::Unfetched => Some(Unverified {
                start_line: start,
                line: end,
            }),
            _ if range.invalid => Some(unplaceable(GithubUnplaceableReason::InvalidAnchor)),
            Mode::Absent => Some(NotShown),
            Mode::Shown => None,
        };
        if let Some(expected) = expected {
            assert_eq!(placement, expected);
            continue;
        }
        let survivors: Vec<u32> = (start - 1..end)
            .filter_map(|index| now_at.get(&(index as usize)).copied())
            .collect();
        let untouched = survivors.len() == (end - start + 1) as usize
            && survivors.windows(2).all(|pair| pair[1] == pair[0] + 1);
        match placement {
            Anchored {
                start_line,
                line,
                published_line,
            } => {
                assert!(untouched || repeats, "anchored an edited range");
                if !repeats {
                    assert_eq!(start_line, survivors[0]);
                }
                assert_eq!(published_line, end);
                assert_eq!(line - start_line, end - start);
                for offset in 0..=end - start {
                    assert_eq!(
                        line_text(&current, start_line + offset),
                        line_text(&published, start + offset)
                    );
                }
            }
            Edited {
                start_line,
                line,
                published: snippet,
            } => {
                assert!(!untouched || repeats, "left an unchanged range");
                assert_eq!((start_line, line), (start, end));
                let expected: Vec<_> = (start..=end)
                    .map(|number| (number, texts[number as usize - 1].as_str()))
                    .collect();
                assert_eq!(focus(&snippet), expected);
            }
            other => panic!("expected Anchored or Edited, got {other:?}"),
        }
    }
}
