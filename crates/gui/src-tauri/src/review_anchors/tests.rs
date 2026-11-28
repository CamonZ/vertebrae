use super::*;
use std::path::Path;

fn commit(repo: &Repository, files: &[(&str, &str)]) -> Oid {
    let root = repo.workdir().unwrap().to_owned();
    let mut index = repo.index().unwrap();
    for (path, text) in files {
        std::fs::write(root.join(path), text).unwrap();
        index.add_path(Path::new(path)).unwrap();
    }
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "fixture",
        &tree,
        &parent.iter().collect::<Vec<_>>(),
    )
    .unwrap()
}

fn range(start_line: u32, line: u32) -> ReviewLineRange {
    ReviewLineRange { start_line, line }
}

#[test]
fn batches_keep_their_order_and_classify_each_anchor() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    let published = commit(&repo, &[("a", "one\ntwo\nthree\n"), ("b", "gone\n")]);
    std::fs::write(dir.path().join("a"), "zero\none\nTWO\nthree\n").unwrap();
    std::fs::remove_file(dir.path().join("b")).unwrap();
    let unknown = Oid::from_str("1111111111111111111111111111111111111111").unwrap();
    let anchor = |published, path, range| PublishedAnchor {
        published,
        shown: Source::WorkingTree,
        path,
        range,
    };
    let placed = place_published_anchors(
        &repo,
        &[
            anchor(published, "a", range(3, 3)),
            anchor(published, "b", range(1, 1)),
            anchor(published, "a", range(1, 1)),
            anchor(published, "a", range(2, 3)),
            anchor(published, "a", range(4, 4)),
            anchor(published, "missing", range(1, 1)),
            anchor(unknown, "a", range(1, 1)),
        ],
    );
    assert_eq!(
        placed,
        vec![
            Ok(PublishedPlacement::Mapped(range(4, 4))),
            Ok(PublishedPlacement::Missing),
            Ok(PublishedPlacement::Mapped(range(2, 2))),
            Ok(PublishedPlacement::Edited { lines: vec![2] }),
            Err(AnchorError::InvalidRange),
            Err(AnchorError::InvalidRange),
            Err(AnchorError::MissingCommit),
        ]
    );
}
