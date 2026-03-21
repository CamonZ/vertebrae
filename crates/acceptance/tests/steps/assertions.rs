use cucumber::then;
use regex::Regex;

use crate::SmokeWorld;

#[then(expr = "the output should contain {string}")]
async fn output_should_contain(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    let output = world.combined_output();
    assert!(
        output.contains(&expected),
        "expected output to contain '{}', but got:\nstdout: '{}'\nstderr: '{}'",
        expected,
        world.last_stdout,
        world.last_stderr
    );
}

#[then(expr = "the output should not contain {string}")]
async fn output_should_not_contain(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    let output = world.combined_output();
    assert!(
        !output.contains(&expected),
        "expected output NOT to contain '{}', but it did.\nstdout: '{}'\nstderr: '{}'",
        expected,
        world.last_stdout,
        world.last_stderr
    );
}

#[then(expr = "the output should match {string}")]
async fn output_should_match(world: &mut SmokeWorld, pattern: String) {
    let pattern = world.resolve_vars(&pattern);
    let output = world.combined_output();
    let re = Regex::new(&pattern)
        .unwrap_or_else(|e| panic!("invalid regex pattern '{}': {}", pattern, e));
    assert!(
        re.is_match(&output),
        "expected output to match pattern '{}', but got:\nstdout: '{}'\nstderr: '{}'",
        pattern,
        world.last_stdout,
        world.last_stderr
    );
}

#[then("the command should succeed")]
async fn command_should_succeed(world: &mut SmokeWorld) {
    assert_eq!(
        world.last_exit_code, 0,
        "expected command to succeed (exit 0), but got exit {}.\nstdout: '{}'\nstderr: '{}'",
        world.last_exit_code, world.last_stdout, world.last_stderr
    );
}

#[then(expr = "the command should fail with {string}")]
async fn command_should_fail_with(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    assert_ne!(
        world.last_exit_code, 0,
        "expected command to fail, but it succeeded (exit 0).\nstdout: '{}'\nstderr: '{}'",
        world.last_stdout, world.last_stderr
    );
    let combined = world.combined_output();
    assert!(
        combined.contains(&expected),
        "expected error output to contain '{}', but got:\nstdout: '{}'\nstderr: '{}'",
        expected,
        world.last_stdout,
        world.last_stderr
    );
}

#[then(expr = "the error should contain {string}")]
async fn error_should_contain(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    let combined = world.combined_output();
    assert!(
        combined.contains(&expected),
        "expected error to contain '{}', but got:\nstdout: '{}'\nstderr: '{}'",
        expected,
        world.last_stdout,
        world.last_stderr
    );
}

#[then(expr = "the hint should contain {string}")]
async fn hint_should_contain(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    let combined = world.combined_output();
    assert!(
        combined.contains(&expected),
        "expected hint to contain '{}', but got:\nstdout: '{}'\nstderr: '{}'",
        expected,
        world.last_stdout,
        world.last_stderr
    );
}

#[then(expr = "the task {word} should be {string}")]
async fn task_field_should_be(world: &mut SmokeWorld, field: String, expected: String) {
    let expected = world.resolve_vars(&expected);
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["show", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to show task as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let actual = match field.as_str() {
        "title" => json["title"].as_str().unwrap_or("").to_string(),
        "level" => json["level"].as_str().unwrap_or("").to_string(),
        "priority" => json["priority"].as_str().unwrap_or("").to_string(),
        "description" => json["description"].as_str().unwrap_or("").to_string(),
        "worktree" => json["worktree"].as_str().unwrap_or("").to_string(),
        "archived" => {
            if json["archived"].as_bool().unwrap_or(false) {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        "needs_human_review" => {
            if json["needs_human_review"].as_bool().unwrap_or(false) {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        other => panic!("unsupported task field for assertion: '{}'", other),
    };

    assert_eq!(
        actual,
        expected,
        "task {} mismatch: expected '{}', got '{}'\nJSON: {}",
        field,
        expected,
        actual,
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "the task {word} should be empty")]
async fn task_field_should_be_empty(world: &mut SmokeWorld, field: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["show", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to show task as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    match field.as_str() {
        "description" => {
            let val = &json["description"];
            assert!(
                val.is_null() || val.as_str() == Some(""),
                "expected description to be empty, got: {}",
                val
            );
        }
        "parent_id" => {
            let val = &json["parent_id"];
            assert!(
                val.is_null(),
                "expected parent_id to be empty, got: {}",
                val
            );
        }
        "worktree" => {
            let val = &json["worktree"];
            assert!(
                val.is_null() || val.as_str() == Some(""),
                "expected worktree to be empty, got: {}",
                val
            );
        }
        other => panic!("unsupported task field for empty assertion: '{}'", other),
    }
}

#[then(expr = "the task should exist with title {string}")]
async fn task_exists_with_title(world: &mut SmokeWorld, expected_title: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["show", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to show task as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let actual_title = json["title"].as_str().unwrap_or("");
    assert_eq!(
        actual_title, expected_title,
        "task title mismatch: expected '{}', got '{}'",
        expected_title, actual_title
    );
}

#[then("the task should no longer exist")]
async fn task_does_not_exist(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["show", &task_id]).await;
    assert_ne!(
        world.last_exit_code, 0,
        "expected task '{}' to not exist, but show succeeded",
        task_id
    );
}

#[then(expr = "task {string} should no longer exist")]
async fn task_ref_should_not_exist(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    world.run_vtb(&["show", &task_id]).await;
    assert_ne!(
        world.last_exit_code, 0,
        "expected task '{}' to not exist, but show succeeded",
        task_id
    );
}

#[then(expr = "task {string} should still exist")]
async fn task_ref_should_still_exist(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    world.run_vtb(&["show", &task_id]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "expected task '{}' to still exist, but show failed: {}{}",
        task_id, world.last_stdout, world.last_stderr
    );
}

#[then(expr = "task {string} should have no parent")]
async fn task_ref_should_have_no_parent(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);

    let json = world
        .run_vtb_json(&["show", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to show task as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    assert!(
        json["parent_id"].is_null(),
        "expected task '{}' to have no parent, but parent_id is {}",
        task_id,
        json["parent_id"]
    );
}

#[then(expr = "the task parent_id should match {string}")]
async fn task_parent_id_should_match(world: &mut SmokeWorld, expected_ref: String) {
    let expected = world.resolve_vars(&expected_ref);
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["show", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to show task as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let actual = json["parent_id"].as_str().unwrap_or("");
    assert!(
        actual.starts_with(&expected),
        "task parent_id mismatch: expected to start with '{}', got '{}'",
        expected,
        actual
    );
}

#[then(expr = "the task should have tags {string}")]
async fn task_should_have_tags(world: &mut SmokeWorld, expected_tags_str: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["show", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to show task as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let mut expected_tags: Vec<String> = expected_tags_str
        .split(", ")
        .map(|s| s.trim().to_string())
        .collect();
    expected_tags.sort();

    let mut actual_tags: Vec<String> = json["tags"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    actual_tags.sort();

    assert_eq!(
        actual_tags, expected_tags,
        "tag mismatch: expected {:?}, got {:?}",
        expected_tags, actual_tags
    );
}

#[then(expr = "the task should not have tag {string}")]
async fn task_should_not_have_tag(world: &mut SmokeWorld, tag: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["show", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to show task as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let tags: Vec<String> = json["tags"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    assert!(
        !tags.contains(&tag),
        "expected task NOT to have tag '{}', but tags are: {:?}",
        tag,
        tags
    );
}

#[then(expr = "the task should be blocked by {string}")]
async fn task_should_be_blocked_by(world: &mut SmokeWorld, blocker_ref: String) {
    let expected_blocker = world.resolve_vars(&blocker_ref);
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["show", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to show task as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let blockers: Vec<String> = json["blockers"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v["id"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    // Check if any blocker ID starts with the expected short ID
    let found = blockers.iter().any(|id| id.starts_with(&expected_blocker));
    assert!(
        found,
        "expected task '{}' to be blocked by '{}', but blockers are: {:?}",
        task_id, expected_blocker, blockers
    );
}

#[then(expr = "the task should have {int} {word} sections")]
async fn task_should_have_n_sections(
    world: &mut SmokeWorld,
    expected_count: usize,
    section_type_str: String,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["sections", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list sections as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_sections = vec![];
    let sections = json["sections"].as_array().unwrap_or(&empty_sections);
    let actual_count = sections
        .iter()
        .filter(|s| s["type"].as_str() == Some(&section_type_str))
        .count();

    assert_eq!(
        actual_count,
        expected_count,
        "expected {} {} sections, but found {}.\nJSON: {}",
        expected_count,
        section_type_str,
        actual_count,
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "the section {string} content should be {string}")]
async fn section_content_should_be(
    world: &mut SmokeWorld,
    section_type_str: String,
    expected_content: String,
) {
    let expected_content = world.resolve_vars(&expected_content);
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["sections", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list sections as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_sections = vec![];
    let sections = json["sections"].as_array().unwrap_or(&empty_sections);
    let section = sections
        .iter()
        .find(|s| s["type"].as_str() == Some(&section_type_str))
        .unwrap_or_else(|| panic!("no {} section found on task", section_type_str));

    let actual = section["content"].as_str().unwrap_or("");
    assert_eq!(
        actual, expected_content,
        "section '{}' content mismatch: expected '{}', got '{}'",
        section_type_str, expected_content, actual
    );
}

#[then(expr = "the task should have a {word} section with content {string}")]
async fn task_should_have_section_with_content(
    world: &mut SmokeWorld,
    section_type_str: String,
    expected_content: String,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["sections", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list sections as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_sections = vec![];
    let sections = json["sections"].as_array().unwrap_or(&empty_sections);
    let section = sections
        .iter()
        .find(|s| s["type"].as_str() == Some(&section_type_str))
        .unwrap_or_else(|| panic!("no {} section found on task", section_type_str));

    let actual = section["content"].as_str().unwrap_or("");
    assert_eq!(
        actual, expected_content,
        "section '{}' content mismatch: expected '{}', got '{}'",
        section_type_str, expected_content, actual
    );
}

#[then(expr = "the task should have a {word} section")]
async fn task_should_have_section_of_type(world: &mut SmokeWorld, section_type_str: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["sections", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list sections as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_sections = vec![];
    let sections = json["sections"].as_array().unwrap_or(&empty_sections);
    let count = sections
        .iter()
        .filter(|s| s["type"].as_str() == Some(&section_type_str))
        .count();

    assert!(
        count > 0,
        "expected task to have at least one {} section, but found 0.\nJSON: {}",
        section_type_str,
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "checklist item {int} should not be done")]
async fn checklist_item_should_not_be_done(world: &mut SmokeWorld, index: usize) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["sections", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list sections as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_sections = vec![];
    let sections = json["sections"].as_array().unwrap_or(&empty_sections);
    let mut items: Vec<&serde_json::Value> = sections
        .iter()
        .filter(|s| s["type"].as_str() == Some("checklist_item"))
        .collect();
    items.sort_by_key(|s| s["order"].as_u64().unwrap_or(u64::MAX));

    let item = items
        .get(index - 1)
        .unwrap_or_else(|| panic!("checklist item {} not found", index));

    let done = item["done"].as_bool().unwrap_or(false);
    assert!(
        !done,
        "expected checklist item {} to NOT be done, but it was",
        index
    );
}

#[then(expr = "the ref should have path {string} and line_start {int}")]
async fn ref_should_have_path_and_line_start(
    world: &mut SmokeWorld,
    expected_path: String,
    expected_line: i32,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["refs", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list refs as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_refs = vec![];
    let refs = json["refs"].as_array().unwrap_or(&empty_refs);
    let found = refs.iter().any(|r| {
        r["path"].as_str() == Some(&expected_path)
            && r["line_start"].as_i64() == Some(expected_line as i64)
    });

    assert!(
        found,
        "expected a code ref with path='{}' and line_start={}, but refs are: {}",
        expected_path,
        expected_line,
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "the ref should have path {string} and line_start {int} and line_end {int}")]
async fn ref_should_have_path_and_line_range(
    world: &mut SmokeWorld,
    expected_path: String,
    expected_start: i32,
    expected_end: i32,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["refs", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list refs as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_refs = vec![];
    let refs = json["refs"].as_array().unwrap_or(&empty_refs);
    let found = refs.iter().any(|r| {
        r["path"].as_str() == Some(&expected_path)
            && r["line_start"].as_i64() == Some(expected_start as i64)
            && r["line_end"].as_i64() == Some(expected_end as i64)
    });

    assert!(
        found,
        "expected a code ref with path='{}', line_start={}, line_end={}, but refs are: {}",
        expected_path,
        expected_start,
        expected_end,
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "the ref should have description {string}")]
async fn ref_should_have_description(world: &mut SmokeWorld, expected_desc: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["refs", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list refs as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_refs = vec![];
    let refs = json["refs"].as_array().unwrap_or(&empty_refs);
    let found = refs
        .iter()
        .any(|r| r["description"].as_str() == Some(&expected_desc));

    assert!(
        found,
        "expected a code ref with description='{}', but refs are: {}",
        expected_desc,
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "the task should have {int} refs")]
async fn task_should_have_n_refs(world: &mut SmokeWorld, expected_count: usize) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["refs", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list refs as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_refs = vec![];
    let refs = json["refs"].as_array().unwrap_or(&empty_refs);
    assert_eq!(
        refs.len(),
        expected_count,
        "expected {} refs, but found {}. Refs: {}",
        expected_count,
        refs.len(),
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "the refs should appear in order: {string}, {string}, {string}")]
async fn refs_should_appear_in_order(
    world: &mut SmokeWorld,
    first: String,
    second: String,
    third: String,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let json = world
        .run_vtb_json(&["refs", &task_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to list refs as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        });

    let empty_refs = vec![];
    let refs = json["refs"].as_array().unwrap_or(&empty_refs);
    let actual_specs: Vec<String> = refs
        .iter()
        .map(|r| {
            let path = r["path"].as_str().unwrap_or("");
            let line_start = r["line_start"].as_u64();
            let line_end = r["line_end"].as_u64();
            match (line_start, line_end) {
                (Some(start), Some(end)) => format!("{}:L{}-{}", path, start, end),
                (Some(line), None) => format!("{}:L{}", path, line),
                _ => path.to_string(),
            }
        })
        .collect();

    let expected = vec![first.clone(), second.clone(), third.clone()];
    assert_eq!(
        actual_specs, expected,
        "expected refs in order {:?}, but got {:?}",
        expected, actual_specs
    );
}
