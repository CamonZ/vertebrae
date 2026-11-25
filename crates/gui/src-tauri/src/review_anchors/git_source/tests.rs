use super::*;

fn commit_all(repo: &Repository, files: &[(&str, &[u8])]) -> Oid {
    let root = repo.workdir().unwrap().to_owned();
    let mut index = repo.index().unwrap();
    for (path, bytes) in files {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, bytes).unwrap();
        index.add_path(Path::new(path)).unwrap();
    }
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "fixture", &tree, &[])
        .unwrap()
}

#[test]
fn commits_and_the_working_tree_read_text_and_report_why_not() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    assert_eq!(open_head(&repo), Err(AnchorError::UnbornHead));
    let commit = commit_all(
        &repo,
        &[("src/a.rs", b"committed\n"), ("bin/blob", b"nul\0\n")],
    );
    std::fs::write(dir.path().join("src/a.rs"), "working\n").unwrap();
    assert_eq!(open_head(&repo), Ok(commit));

    let at = Source::Commit(commit);
    assert_eq!(
        read_text(&repo, at, "src/a.rs").unwrap().as_deref(),
        Some(&b"committed\n"[..])
    );
    assert_eq!(
        read_text(&repo, Source::WorkingTree, "src/a.rs")
            .unwrap()
            .as_deref(),
        Some(&b"working\n"[..])
    );
    assert_eq!(read_text(&repo, at, "src/missing.rs"), Ok(None));
    assert_eq!(read_text(&repo, Source::WorkingTree, "nope/a.rs"), Ok(None));
    // A directory, binary content, a path outside the checkout, and a
    // commit this clone does not have.
    assert_eq!(read_text(&repo, at, "src"), Err(AnchorError::Unreadable));
    assert_eq!(
        read_text(&repo, at, "bin/blob"),
        Err(AnchorError::Unreadable)
    );
    assert_eq!(
        read_text(&repo, at, "../outside"),
        Err(AnchorError::InvalidPath)
    );
    let unknown = Oid::from_str("1111111111111111111111111111111111111111").unwrap();
    assert_eq!(
        read_text(&repo, Source::Commit(unknown), "src/a.rs"),
        Err(AnchorError::MissingCommit)
    );
}

#[cfg(unix)]
#[test]
fn working_file_rejects_a_symlinked_parent() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    std::fs::write(outside.path().join("a"), "outside").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
    assert_eq!(working_file(&repo, "link/a"), Err(AnchorError::InvalidPath));
}
