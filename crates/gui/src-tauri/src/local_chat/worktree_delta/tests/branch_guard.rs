use super::*;

#[tokio::test]
async fn same_commit_other_branch_and_detached_head_are_skipped_then_recording_resumes() {
    let (_repo, worktree) = repo();
    git(&worktree, &["branch", "other"]);
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());
    session.sentinel(&worktree, "before").await;
    let head = git(&worktree, &["rev-parse", "HEAD"]);

    git(&worktree, &["checkout", "-q", "other"]);
    assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), head);
    session
        .tool("other", || write(&worktree, "other.txt", "other\n"))
        .await;
    git(&worktree, &["checkout", "-q", "--detach"]);
    session
        .tool("detached", || {
            write(&worktree, "detached.txt", "detached\n")
        })
        .await;
    // The next tool takes a fresh baseline even though the commit never changed.
    git(&worktree, &["checkout", "-q", "main"]);
    // A repeated started/running event must not revive a tool skipped on other.
    session
        .tool("other", || write(&worktree, "late.txt", "late\n"))
        .await;
    session.sentinel(&worktree, "after").await;
    session.assert_none("other");
    session.assert_none("detached");
    assert_eq!(
        paths(&session.annotation("after").await),
        ["after.sentinel"]
    );
}

#[tokio::test]
async fn switching_branch_inside_overlapping_tools_drops_all_open_windows() {
    let (_repo, worktree) = repo();
    git(&worktree, &["branch", "other"]);
    let (_annotations, store) = store();
    let session = Session::recording(&worktree, store, fast_config());
    session.sentinel(&worktree, "before").await;
    session.root(tool_call("crossing-a", "Bash")).await;
    session.root(tool_call("crossing-b", "Bash")).await;
    tool_starts().await;
    write(&worktree, "crossing.txt", "unattributed\n");
    git(&worktree, &["checkout", "-q", "other"]);
    session.root(tool_output("crossing-a")).await;
    // Let the mismatched end checkpoint retire both windows before returning.
    tokio::time::sleep(Duration::from_millis(300)).await;
    git(&worktree, &["checkout", "-q", "main"]);
    session.root(tool_output("crossing-b")).await;
    session.sentinel(&worktree, "after").await;
    session.assert_none("crossing-a");
    session.assert_none("crossing-b");
    assert_eq!(
        paths(&session.annotation("after").await),
        ["after.sentinel"]
    );
}

#[tokio::test]
async fn resumed_runtime_keeps_the_persisted_branch_and_same_path_can_be_rebound() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let manager = manager(&store);
    // The persisted association intends main, but the checkout has changed
    // before this runtime starts. It must not adopt other from the disk.
    let request = input("backend-1", CHAT, &worktree, Some(&worktree));
    git(&worktree, &["checkout", "-q", "-b", "other"]);
    let session = start(&manager, &store, request).await;
    session
        .tool("wrong-on-resume", || {
            write(&worktree, "other.txt", "other\n")
        })
        .await;
    manager
        .set_recording_worktree(
            "backend-1",
            Some(worktree.to_string_lossy().into_owned()),
            Some("other".into()),
        )
        .await
        .unwrap();
    session.sentinel(&worktree, "after-rebind").await;
    session.assert_none("wrong-on-resume");
    assert_eq!(
        paths(&session.annotation("after-rebind").await),
        ["after-rebind.sentinel"]
    );
    manager.close_session("backend-1").await.unwrap();
}

#[tokio::test]
async fn missing_intended_branch_does_not_capture_on_runtime_start() {
    let (_repo, worktree) = repo();
    let (_annotations, store) = store();
    let manager = manager(&store);
    let mut request = input("backend-1", CHAT, &worktree, Some(&worktree));
    request.recording_branch = None;
    let session = start(&manager, &store, request).await;
    session
        .tool("unbound", || write(&worktree, "unbound.txt", "x\n"))
        .await;
    manager
        .set_recording_worktree(
            "backend-1",
            Some(worktree.to_string_lossy().into_owned()),
            Some("main".into()),
        )
        .await
        .unwrap();
    session.sentinel(&worktree, "bound").await;
    session.assert_none("unbound");
    manager.close_session("backend-1").await.unwrap();
}
