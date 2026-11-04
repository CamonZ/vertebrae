//! Integration cases specific to the library-backed Git boundary.

use super::*;

#[test]
fn unborn_detached_conflicts_and_literal_paths_have_explicit_outcomes() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-b", "main"]);

    let limits = git::Limits::default();
    let start = git::snapshot(&root, &limits, "main").unwrap();
    assert_eq!(start.head, None);

    write(&root, "space and\nnewline.txt", "new\n");
    let end = git::snapshot(&root, &limits, "main").unwrap();
    let delta = patch::compute(&root, &start, &end, &limits).unwrap();

    assert_eq!(delta.files[0].path, "space and\nnewline.txt");
    assert!(delta.patch.contains("+new"));
    assert!(crate::local_chat::changes::load(&root, false).is_err());

    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "first commit during tool"]);

    let committed = git::snapshot_since(&root, &limits, "main", Some(&start)).unwrap();
    let delta = patch::compute(&root, &start, &committed, &limits).unwrap();

    assert!(delta.head_changed);
    assert_eq!(delta.files.len(), 1);
    assert!(delta.patch.contains("+new"));

    let (_repo, root) = repo();
    git(&root, &["checkout", "--detach"]);
    assert!(crate::local_chat::changes::load(&root, false).is_ok());

    git(&root, &["checkout", "main"]);
    git(&root, &["checkout", "-b", "conflict"]);
    write(&root, "edit.txt", "other\n");
    git(&root, &["commit", "-am", "other"]);
    git(&root, &["checkout", "main"]);
    write(&root, "edit.txt", "ours\n");
    git(&root, &["commit", "-am", "ours"]);
    assert!(!Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["merge", "conflict"])
        .output()
        .unwrap()
        .status
        .success());
    assert!(git::snapshot(&root, &limits, "main")
        .unwrap()
        .dirty
        .contains("edit.txt"));
    assert!(crate::local_chat::changes::load(&root, false)
        .unwrap()
        .files
        .iter()
        .any(|file| file.path == "edit.txt"));
}

#[cfg(target_os = "linux")]
#[test]
fn invalid_utf8_paths_are_rejected_without_lossy_attribution() {
    use std::os::unix::ffi::OsStringExt;
    let (_repo, root) = repo();
    let path = std::ffi::OsString::from_vec(b"invalid-\xff".to_vec());
    std::fs::write(root.join(path), "x").unwrap();

    assert!(matches!(
        git::snapshot(&root, &git::Limits::default(), "main"),
        Err(git::GitError::Malformed(_))
    ));
    assert!(crate::local_chat::changes::load(&root, false).is_err());
}

#[test]
fn crlf_and_attributes_use_physical_captured_bytes_without_executing_filters() {
    let (_repo, root) = repo();
    write(
        &root,
        ".gitattributes",
        "edit.txt text eol=crlf filter=unavailable\n",
    );
    git(&root, &["add", ".gitattributes"]);
    git(&root, &["commit", "-m", "attributes"]);

    let limits = git::Limits::default();
    write(&root, "edit.txt", "before\r\n");
    let start = git::snapshot(&root, &limits, "main").unwrap();
    write(&root, "edit.txt", "after\r\n");
    let end = git::snapshot_since(&root, &limits, "main", Some(&start)).unwrap();
    let delta = patch::compute(&root, &start, &end, &limits).unwrap();

    assert!(delta.patch.contains("-before\r\n+after\r\n"));
}

#[test]
fn edited_rename_is_library_detected_and_budget_exhaustion_is_explicit() {
    let (_repo, root) = repo();
    write(&root, "old.txt", numbered(100));
    git(&root, &["add", "old.txt"]);
    git(&root, &["commit", "-m", "rename fixture"]);

    let limits = git::Limits::default();
    let start = git::snapshot(&root, &limits, "main").unwrap();

    std::fs::rename(root.join("old.txt"), root.join("renamed.txt")).unwrap();
    write(
        &root,
        "renamed.txt",
        numbered(100).replace("line 50\n", "line fifty\n"),
    );
    let end = git::snapshot_since(&root, &limits, "main", Some(&start)).unwrap();
    let delta = patch::compute(&root, &start, &end, &limits).unwrap();

    assert_eq!(delta.files.len(), 1);
    assert_eq!(delta.files[0].status, FileStatus::Renamed);
    assert_eq!(delta.files[0].old_path.as_deref(), Some("old.txt"));
    assert!(delta.patch.contains("+line fifty"));

    assert!(matches!(
        git::snapshot(
            &root,
            &git::Limits {
                status_entries: 1,
                ..limits
            },
            "main"
        ),
        Err(git::GitError::TooManyEntries(_))
    ));
}

#[cfg(unix)]
#[test]
fn symlink_patches_change_the_link_without_following_its_target() {
    use std::os::unix::fs::symlink;

    let (_repo, root) = repo();
    symlink("edit.txt", root.join("link")).unwrap();
    git(&root, &["add", "link"]);
    git(&root, &["commit", "-m", "symlink"]);

    let limits = git::Limits::default();
    let start = git::snapshot(&root, &limits, "main").unwrap();

    std::fs::remove_file(root.join("link")).unwrap();
    symlink("missing.txt", root.join("link")).unwrap();
    let end = git::snapshot_since(&root, &limits, "main", Some(&start)).unwrap();
    let delta = patch::compute(&root, &start, &end, &limits).unwrap();

    assert_eq!(delta.files.len(), 1);
    assert_eq!(delta.files[0].path, "link");
    assert!(delta.patch.contains("120000"));
    assert!(delta.patch.contains("-edit.txt\n"));
    assert!(delta.patch.contains("+missing.txt\n"));
}
