use super::*;

#[test]
fn mapping_follows_only_contiguous_unchanged_lines() {
    let original = b"before\nfirst\nsecond\nafter\n";
    let range = ReviewLineRange {
        start_line: 2,
        line: 3,
    };
    for (current, expected) in [
        (&b"before\nfirst\nsecond\nafter\n"[..], Some((2, 3))),
        (&b"new\nbefore\nfirst\nsecond\nafter\n"[..], Some((3, 4))),
        (&b"before\nnew\nfirst\nsecond\nafter\n"[..], Some((3, 4))),
        (&b"first\nsecond\nafter\n"[..], Some((1, 2))),
        (&b"before\nfirst\nsecond\nnew\nafter\n"[..], Some((2, 3))),
        (&b"before\nfirst\nnew\nsecond\nafter\n"[..], None),
        (&b"before\nfirst\nedited\nafter\n"[..], None),
        (&b"before\nsecond\nafter\n"[..], None),
        (&b""[..], None),
    ] {
        for _ in 0..2 {
            let mapped = map_range(original, current, range).unwrap();
            assert_eq!(mapped.map(|r| (r.start_line, r.line)), expected);
            if let Some(mapped) = mapped {
                assert_eq!(
                    mapped.slice(current).unwrap(),
                    range.slice(original).unwrap()
                );
            }
        }
    }
}

#[hegel::test]
fn line_mapping_matches_a_generated_edit_oracle(tc: hegel::TestCase) {
    use hegel::generators as gs;
    use std::collections::BTreeMap;
    let count = tc.draw(gs::integers::<usize>().min_value(4).max_value(30));
    let start = tc.draw(gs::integers::<usize>().max_value(count - 1));
    let end = tc.draw(
        gs::integers::<usize>()
            .min_value(start)
            .max_value(count - 1),
    );
    let original: Vec<_> = (0..count).map(|index| format!("line-{index}\n")).collect();
    // Assign two or three edits to distinct original lines. Track original
    // identities through the edits to find the range without diffing text.
    let edit_count = tc.draw(gs::integers::<usize>().min_value(2).max_value(3));
    let mut edits = BTreeMap::new();
    let mut candidates: Vec<_> = (0..count).collect();
    for _ in 0..edit_count {
        let index = tc.draw(gs::integers::<usize>().max_value(candidates.len() - 1));
        let operation = tc.draw(gs::integers::<u8>().max_value(2));
        edits.insert(candidates.swap_remove(index), operation);
    }
    let mut current = String::new();
    let mut surviving = Vec::new();
    let mut current_line = 0;
    for (index, line) in original.iter().enumerate() {
        match edits.get(&index) {
            Some(0) => {
                current.push_str(&format!("inserted-{index}\n"));
                current_line += 1;
            }
            Some(1) => continue,
            Some(2) => {
                current.push_str(&format!("edited-{index}\n"));
                current_line += 1;
                continue;
            }
            _ => {}
        }
        if (start..=end).contains(&index) {
            surviving.push(current_line);
        }
        current.push_str(line);
        current_line += 1;
    }
    let expected = (surviving.len() == end - start + 1
        && surviving
            .windows(2)
            .all(|window| window[1] == window[0] + 1))
    .then(|| surviving[0]);
    let original = original.concat();
    let range = ReviewLineRange {
        start_line: start as u32 + 1,
        line: end as u32 + 1,
    };
    let mapped = map_range(original.as_bytes(), current.as_bytes(), range).unwrap();
    assert_eq!(
        mapped.map(|range| range.start_line),
        expected.map(|start| start as u32 + 1)
    );
    // The edited lines are exactly the range's replaced or removed lines;
    // an insertion inside the range edits no published line.
    let edited: Vec<u32> = (start..=end)
        .filter(|index| matches!(edits.get(index), Some(1 | 2)))
        .map(|index| index as u32 + 1)
        .collect();
    assert_eq!(
        LineMap::new(original.as_bytes(), current.as_bytes())
            .unwrap()
            .edited_lines(range)
            .unwrap(),
        edited
    );
    if let Some(mapped) = mapped {
        assert_eq!(
            range.slice(original.as_bytes()).unwrap(),
            mapped.slice(current.as_bytes()).unwrap()
        );
    }
}

#[test]
fn mapping_survives_repeated_lines_and_no_final_newline() {
    let range = ReviewLineRange {
        start_line: 2,
        line: 3,
    };
    let mapped = map_range(b"same\nsame\nend", b"inserted\nsame\nsame\nend", range)
        .unwrap()
        .unwrap();
    assert_eq!((mapped.start_line, mapped.line), (3, 4));
}

#[test]
fn numbered_lines_clamp_and_drop_line_endings() {
    let text = "one\r\ntwo\nthree\r";
    assert_eq!(
        numbered_lines(text, 0, 9),
        vec![(1, "one".into()), (2, "two".into()), (3, "three".into())]
    );
    assert_eq!(numbered_lines(text, 2, 2), vec![(2, "two".into())]);
    assert!(numbered_lines(text, 4, 9).is_empty());
}
