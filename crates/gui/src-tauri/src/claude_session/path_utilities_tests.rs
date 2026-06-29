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
    // '…' (U+2026) is 3 bytes in UTF-8 (0xE2 0x80 0xA6).
    // Place it so a naive byte slice at 200 would land inside the character.
    let line = "a".repeat(198) + "…" + &"b".repeat(50); // '…' spans bytes 198..201
    assert_eq!(line.len(), 251); // 198 + 3 + 50

    // Truncation at 200 must not panic and must land on a char boundary
    let truncated = truncate_utf8(&line, 200);
    assert!(truncated.is_char_boundary(truncated.len()));
    // Should truncate before the '…' since byte 200 is inside it
    assert_eq!(truncated.len(), 198);
    assert_eq!(truncated, "a".repeat(198).as_str());

    // Same test for the 100-byte truncation path
    let line_100 = "x".repeat(98) + "…" + &"y".repeat(50); // '…' spans bytes 98..101
    assert_eq!(line_100.len(), 151);

    let truncated_100 = truncate_utf8(&line_100, 100);
    assert!(truncated_100.is_char_boundary(truncated_100.len()));
    assert_eq!(truncated_100.len(), 98);
    assert_eq!(truncated_100, "x".repeat(98).as_str());
}

#[test]
fn test_utf8_safe_truncation_with_string_shorter_than_limit() {
    let short = "hello…world";
    let len = short.len(); // "hello" = 5, "…" = 3, "world" = 5 => 13
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
    // All 3-byte characters — truncating at 1 or 2 must walk back to 0
    let s = "………"; // 3 × 3 bytes = 9 bytes
    assert_eq!(s.len(), 9);

    assert_eq!(truncate_utf8(s, 1), "");
    assert_eq!(truncate_utf8(s, 2), "");
    assert_eq!(truncate_utf8(s, 3), "…");
    assert_eq!(truncate_utf8(s, 5), "…");
    assert_eq!(truncate_utf8(s, 6), "……");
}

#[test]
fn test_utf8_safe_truncation_exact_boundary() {
    let s = "abc…def"; // 3 + 3 + 3 = 9 bytes
    assert_eq!(s.len(), 9);

    // Truncate exactly at char boundary
    assert_eq!(truncate_utf8(s, 3), "abc");
    assert_eq!(truncate_utf8(s, 6), "abc…");
    assert_eq!(truncate_utf8(s, 9), "abc…def");
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
    // The current process PATH should appear in the augmented result
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
        // Find the start of the original PATH within the augmented one.
        // The original PATH is appended as the last segment, so find it from the end.
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
    // At minimum: ~/.cargo/bin, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin
    assert!(
        segments.len() >= 4,
        "PATH should have at least 4 segments, got {}: {}",
        segments.len(),
        path
    );
}
