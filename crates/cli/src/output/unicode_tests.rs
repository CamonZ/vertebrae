use super::*;

fn task(title: &str, tags: &[&str]) -> TaskSummary {
    TaskSummary {
        id: "abc12345".into(),
        title: title.into(),
        level: "task".into(),
        workflow_name: Some("default".into()),
        step_name: Some("todo".into()),
        run_state: None,
        active_task_run_id: None,
        latest_step_execution_id: None,
        priority: Some("high".into()),
        tags: tags.iter().map(|s| (*s).into()).collect(),
        archived: true,
        parent_id: None,
    }
}

#[test]
fn unicode_truncation_examples() {
    for text in ["é".repeat(16), "🦀".repeat(8), "界".repeat(11)] {
        assert_eq!(truncate(&text, 30), text);
    }
    assert_eq!(
        truncate(&"界".repeat(16), 30),
        format!("{}...", "界".repeat(13))
    );
    for cluster in ["e\u{301}", "👍🏽", "👩‍💻", "👨‍👩‍👧‍👦", "🇪🇸", "❤️"]
    {
        let text = format!("ab{cluster}xyzq");
        assert_eq!(truncate(&text, 4), "a...");
        let width = display_width(cluster);
        assert_eq!(truncate(&text, width + 5), format!("ab{cluster}..."));
        assert_eq!(truncate(&text, width + 6), text);
    }
    for (text, budget, expected) in [
        ("", 0, ""),
        ("abc", 0, ""),
        ("🦀x", 1, ""),
        ("🦀xy", 2, "🦀"),
        ("界界", 3, "界"),
        ("hello", 3, "hel"),
        ("hello", 2, "he"),
        ("hello", 1, "h"),
        ("abcd", 4, "abcd"),
        ("abcde", 4, "a..."),
    ] {
        assert_eq!(truncate(text, budget), expected);
    }
}

#[test]
fn tree_and_flat_render_reported_unicode_titles_and_tags() {
    for title in ["é".repeat(16), "🦀".repeat(8), "界".repeat(11)] {
        let tag = "é".repeat(11);
        let tasks = [task(&title, &[&tag])];
        assert!(format_task_table(&tasks).contains(&title));
        assert!(format_task_table(&tasks).contains(&tag));
        assert!(format_task_tree(&tasks, &HashMap::new()).contains(&title));
    }
    let tasks = [task(&"👩‍💻".repeat(16), &[&"👍🏽".repeat(11)])];
    let flat = format_task_table(&tasks);
    assert!(flat.contains(&format!("{}...", "👩‍💻".repeat(13))));
    assert!(flat.contains(&format!("{}...", "👍🏽".repeat(8))));
    assert!(format_task_tree(&tasks, &HashMap::new()).contains(&format!("{}...", "👩‍💻".repeat(13))));
}

#[test]
fn flat_columns_align_by_terminal_cells() {
    let values = ["ascii", "éclair", "界面", "e\u{301}cole", "👩‍💻", "👍🏽"];
    let tasks: Vec<_> = values
        .iter()
        .map(|value| {
            let mut task = task(value, &[value]);
            task.workflow_name = Some(format!("wf{value}"));
            task.step_name = Some(format!("step{value}"));
            task
        })
        .collect();
    let table = format_task_table(&tasks);
    let header = table.lines().next().unwrap();
    let starts: Vec<_> = [
        "ID", "Level", "Workflow", "Run", "Priority", "Title", "Tags", "[A]",
    ]
    .iter()
    .map(|label| display_width(&header[..header.find(label).unwrap()]))
    .collect();
    for (line, task) in table.lines().skip(2).zip(&tasks) {
        let cells = [
            task.id.clone(),
            task.level.clone(),
            format_workflow_position_display(task),
            "idle".into(),
            "high".into(),
            task.title.clone(),
            format_tags(&task.tags),
            "[A]".into(),
        ];
        let mut byte_offset = 0;
        for (column, cell) in cells.iter().enumerate() {
            let index = byte_offset + line[byte_offset..].find(cell).unwrap();
            assert_eq!(display_width(&line[..index]), starts[column], "{line}");
            byte_offset = index + cell.len();
        }
        assert_eq!(display_width(line), display_width(header));
    }
}

#[test]
fn truncation_invariants_over_generated_unicode_sequences() {
    // Exhaustive bounded corpus, reproducible without a random seed or new test dependency.
    // Known cluster widths form an independent oracle for these combinations.
    let alphabet = [
        ("a", 1),
        ("é", 1),
        ("界", 2),
        ("e\u{301}", 1),
        ("👍🏽", 2),
        ("👩‍💻", 2),
        ("🇪🇸", 2),
        ("", 0),
    ];
    for (a, aw) in alphabet {
        for (b, bw) in alphabet {
            for (c, cw) in alphabet {
                let text = format!("{a}{b}{c}");
                for budget in 0..=10 {
                    let actual = truncate(&text, budget);
                    assert!(display_width(&actual) <= budget, "{text:?} / {budget}");
                    if aw + bw + cw <= budget {
                        assert_eq!(actual, text);
                    } else {
                        let prefix = if budget > 3 {
                            actual.strip_suffix("...").expect("truncated suffix")
                        } else {
                            &actual
                        };
                        assert!(text.starts_with(prefix));
                        assert!(
                            prefix.is_empty()
                                || text
                                    .grapheme_indices(true)
                                    .any(|(index, cluster)| index + cluster.len() == prefix.len())
                        );
                    }
                    assert_eq!(truncate(&actual, budget), actual);
                }
            }
        }
    }
}
