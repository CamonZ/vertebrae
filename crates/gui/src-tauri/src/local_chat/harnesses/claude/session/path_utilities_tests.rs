use super::*;

#[test]
fn test_current_project_path_returns_none_without_managed_state() {
    let app = tauri::test::mock_app();

    assert_eq!(current_project_path(app.handle()), None);
}

#[test]
fn test_resolve_working_dir_uses_explicit_path() {
    let app = tauri::test::mock_app();

    assert_eq!(
        resolve_working_dir(Some("/repo/root".to_string()), app.handle()).as_deref(),
        Some("/repo/root")
    );
}

#[test]
fn test_resolve_working_dir_rejects_blank_path_without_fallback() {
    let app = tauri::test::mock_app();

    assert_eq!(
        resolve_working_dir(Some("  ".to_string()), app.handle()),
        None
    );
}

#[test]
fn test_utf8_safe_truncation_does_not_panic() {
    let line = "a".repeat(198) + "\u{2026}" + &"b".repeat(50);
    assert_eq!(line.len(), 251);

    let truncated = truncate_utf8(&line, 200);
    assert!(truncated.is_char_boundary(truncated.len()));
    assert_eq!(truncated.len(), 198);
    assert_eq!(truncated, "a".repeat(198).as_str());

    let line_100 = "x".repeat(98) + "\u{2026}" + &"y".repeat(50);
    assert_eq!(line_100.len(), 151);

    let truncated_100 = truncate_utf8(&line_100, 100);
    assert!(truncated_100.is_char_boundary(truncated_100.len()));
    assert_eq!(truncated_100.len(), 98);
    assert_eq!(truncated_100, "x".repeat(98).as_str());
}

#[test]
fn test_utf8_safe_truncation_with_string_shorter_than_limit() {
    let short = "hello\u{2026}world";
    let len = short.len();
    assert_eq!(len, 13);

    let truncated = truncate_utf8(short, 200);
    assert_eq!(truncated, short);
}

#[test]
fn test_utf8_safe_truncation_zero_max_bytes() {
    let s = "hello";
    let truncated = truncate_utf8(s, 0);
    assert_eq!(truncated, "");
}

#[test]
fn test_utf8_safe_truncation_all_multibyte() {
    let s = "\u{2026}\u{2026}\u{2026}";
    assert_eq!(s.len(), 9);

    assert_eq!(truncate_utf8(s, 1), "");
    assert_eq!(truncate_utf8(s, 2), "");
    assert_eq!(truncate_utf8(s, 3), "\u{2026}");
    assert_eq!(truncate_utf8(s, 5), "\u{2026}");
    assert_eq!(truncate_utf8(s, 6), "\u{2026}\u{2026}");
}

#[test]
fn test_utf8_safe_truncation_exact_boundary() {
    let s = "abc\u{2026}def";
    assert_eq!(s.len(), 9);

    assert_eq!(truncate_utf8(s, 3), "abc");
    assert_eq!(truncate_utf8(s, 6), "abc\u{2026}");
    assert_eq!(truncate_utf8(s, 9), "abc\u{2026}def");
}

// ========================================================================
// build_augmented_path tests
// ========================================================================

#[test]
fn test_build_augmented_path_contains_cargo_bin() {
    let path = build_augmented_path();
    let home = dirs::home_dir().expect("test requires HOME to be set");
    let cargo_bin = home.join(".cargo").join("bin");
    let cargo_bin_str = cargo_bin.to_string_lossy();

    assert!(
        path.contains(&*cargo_bin_str),
        "PATH should contain {}, got: {}",
        cargo_bin_str,
        path
    );
}

#[test]
fn test_build_augmented_path_contains_local_bin() {
    let path = build_augmented_path();
    let home = dirs::home_dir().expect("test requires HOME to be set");
    let local_bin = home.join(".local").join("bin");
    let local_bin_str = local_bin.to_string_lossy();

    assert!(
        path.contains(&*local_bin_str),
        "PATH should contain {}, got: {}",
        local_bin_str,
        path
    );
}

#[test]
fn test_build_augmented_path_contains_homebrew_bin() {
    let path = build_augmented_path();
    assert!(
        path.contains("/opt/homebrew/bin"),
        "PATH should contain /opt/homebrew/bin, got: {}",
        path
    );
}

#[test]
fn test_build_augmented_path_contains_usr_local_bin() {
    let path = build_augmented_path();
    assert!(
        path.contains("/usr/local/bin"),
        "PATH should contain /usr/local/bin, got: {}",
        path
    );
}

#[test]
fn test_build_augmented_path_preserves_existing_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    if !current.is_empty() {
        let path = build_augmented_path();
        assert!(
            path.contains(&current),
            "Augmented PATH should contain the original PATH '{}', got: {}",
            current,
            path
        );
    }
}

#[test]
fn test_build_augmented_path_cargo_bin_before_existing_path() {
    let path = build_augmented_path();
    let home = dirs::home_dir().expect("test requires HOME to be set");
    let cargo_bin = home
        .join(".cargo")
        .join("bin")
        .to_string_lossy()
        .to_string();

    let cargo_pos = path.find(&cargo_bin).expect("cargo/bin should be in PATH");
    let current = std::env::var("PATH").unwrap_or_default();
    if !current.is_empty() {
        let original_pos = path
            .rfind(&current)
            .expect("original PATH should be in PATH");
        assert!(
            cargo_pos < original_pos,
            "~/.cargo/bin (pos {}) should appear before the original PATH (pos {})",
            cargo_pos,
            original_pos
        );
    }
}

#[test]
fn test_build_augmented_path_is_colon_separated() {
    let path = build_augmented_path();
    let segments: Vec<&str> = path.split(':').collect();
    assert!(
        segments.len() >= 4,
        "PATH should have at least 4 segments, got {}: {}",
        segments.len(),
        path
    );
}
