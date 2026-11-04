//! Attribution property of the live recorder: whenever a provider runs a tool
//! relative to its announcement, and whatever the pauses between tools, each
//! tool's annotation holds exactly the file that tool wrote.

use hegel::generators as gs;
use hegel::TestCase;

use super::*;

/// Pauses between tools are several idle-checkpoint intervals long
/// (`fast_config` refreshes every 20 ms), so hand edits are never in play and
/// the oracle is exact.
const MIN_GAP_MS: u64 = 100;

#[hegel::test(test_cases = 15)]
fn each_tool_is_attributed_exactly_the_file_it_wrote(tc: TestCase) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let tools = tc.draw(gs::integers::<usize>().min_value(1).max_value(4));
    let plan: Vec<(u64, u64)> = (0..tools)
        .map(|_| {
            // Time from announcement to the write; 0 is the Edit/Write case
            // that finishes before any snapshot started at the announcement.
            let write_after = tc.draw(gs::integers::<u64>().max_value(40));
            let gap = tc.draw(gs::integers::<u64>().min_value(MIN_GAP_MS).max_value(160));
            (write_after, gap)
        })
        .collect();
    tc.note(&format!("(write_after_ms, gap_ms) per tool: {plan:?}"));

    runtime.block_on(async {
        let (_repo, worktree) = repo();
        let (_annotations, store) = store();
        let session = Session::recording(&worktree, store, fast_config());
        for (index, (write_after, gap)) in plan.iter().enumerate() {
            tokio::time::sleep(Duration::from_millis(*gap)).await;
            let id = format!("toolu_{index}");
            session.root(tool_call(&id, "Edit")).await;
            tokio::time::sleep(Duration::from_millis(*write_after)).await;
            write(
                &worktree,
                &format!("f{index}.txt"),
                format!("content {index}\n"),
            );
            tokio::time::sleep(Duration::from_millis(40)).await;
            session.root(tool_output(&id)).await;
        }
        for index in 0..plan.len() {
            let annotation = session.annotation(&format!("toolu_{index}")).await;
            assert_eq!(
                paths(&annotation),
                [format!("f{index}.txt")],
                "tool {index} was attributed the wrong files"
            );
        }
    });
}

/// Hold patch computation until after the next writer has changed both a dirty
/// path and a path that reverted to HEAD. No scheduler/timing assumption is
/// needed: the channel is the end-capture/next-write barrier.
#[test]
fn captured_end_excludes_later_writes_even_when_a_path_reverted_to_head() {
    let (_repo, root) = repo();
    let limits = git::Limits::default();
    write(&root, "edit.txt", "dirty before\n");
    let start = git::snapshot(&root, &limits, "main").unwrap();

    write(&root, "edit.txt", numbered(10));
    write(&root, "new.txt", "first tool\n");
    let end = git::snapshot(&root, &limits, "main").unwrap();

    let (resume, wait) = std::sync::mpsc::sync_channel(0);
    let worker_root = root.clone();
    let worker = std::thread::spawn(move || {
        wait.recv().unwrap();
        patch::compute(&worker_root, &start, &end, &limits).unwrap()
    });

    write(&root, "edit.txt", "later edit\n");
    write(&root, "new.txt", "next tool\n");
    resume.send(()).unwrap();
    let delta = worker.join().unwrap();

    assert!(delta.patch.contains("-dirty before"));
    assert!(delta.patch.contains("+line 1"));
    assert!(delta.patch.contains("+first tool"));
    assert!(!delta.patch.contains("later edit"));
    assert!(!delta.patch.contains("next tool"));
}
