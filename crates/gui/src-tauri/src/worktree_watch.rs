//! Filesystem subscriptions owned by Changes views and delta recorders.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_specta::Event;
use tokio::{io::AsyncWriteExt, sync::mpsc};

use crate::commands::CommandError;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct WorktreeChangedEvent {
    pub watch_id: String,
}

pub(crate) struct Subscription {
    _watcher: RecommendedWatcher,
    worker: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(worker) = &self.worker {
            worker.abort();
        }
    }
}

impl Subscription {
    pub(crate) async fn stop(mut self) {
        if let Some(worker) = self.worker.take() {
            worker.abort();
            if let Err(error) = worker.await {
                if !error.is_cancelled() {
                    log::warn!("worktree watch worker failed: {error}");
                }
            }
        }
    }
}

struct Watch {
    window: String,
    subscription: Subscription,
}

#[derive(Default)]
pub struct WorktreeWatches(Mutex<HashMap<String, Watch>>);

impl WorktreeWatches {
    pub fn close_window(&self, label: &str) {
        if let Ok(mut watches) = self.0.lock() {
            watches.retain(|_, watch| watch.window != label);
        }
    }
}

fn relevant_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let relative = path.strip_prefix(root).ok()?;
    if relative.components().any(|part| part.as_os_str() == ".git") {
        return None;
    }
    Some(relative.to_owned())
}

/// Git supplies repository, global and info/exclude rules, including negation
/// and tracked-file exceptions. Deleted paths are deliberately retained.
async fn has_visible_path(root: &Path, paths: &[PathBuf]) -> std::io::Result<bool> {
    let mut child = tokio::process::Command::new("git")
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().expect("piped stdin");
    // Input is bounded by the notification batch; write and drain concurrently
    // so a large ignored batch cannot fill both process pipes.
    let write = async {
        for path in paths {
            input.write_all(path.as_os_str().as_encoded_bytes()).await?;
            input.write_all(&[0]).await?;
        }
        drop(input);
        Ok::<_, std::io::Error>(())
    };
    let ((), output) = tokio::try_join!(write, child.wait_with_output())?;
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Err(std::io::Error::other("git check-ignore failed"));
    }
    let ignored = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .count();
    Ok(ignored < paths.len())
}

#[tauri::command]
#[specta::specta]
pub async fn watch_worktree(
    app: tauri::AppHandle,
    window: tauri::Window,
    watches: State<'_, WorktreeWatches>,
    worktree_path: String,
) -> Result<String, CommandError> {
    let id = uuid::Uuid::new_v4().to_string();
    let watch_id = id.clone();
    let event_app = app.clone();
    let subscription = subscribe(
        Path::new(&worktree_path),
        Duration::from_millis(150),
        move || {
            if let Err(error) = (WorktreeChangedEvent {
                watch_id: watch_id.clone(),
            })
            .emit(&event_app)
            {
                log::warn!("could not emit worktree change: {error}");
            }
        },
    )
    .await?;
    let mut registry = watches.0.lock().map_err(error)?;
    // Native destruction can race the blocking registration above. Check
    // while holding the same registry lock used by the destruction handler.
    if app.get_webview_window(window.label()).is_none() {
        return Err(error("watch window was closed"));
    }
    registry.insert(
        id.clone(),
        Watch {
            window: window.label().to_owned(),
            subscription,
        },
    );
    Ok(id)
}

/// Own a native watcher independently of any GUI view. The recorder uses a
/// shorter batch window so external edits are absorbed before the next tool.
pub(crate) async fn subscribe(
    worktree: &Path,
    debounce: Duration,
    changed: impl Fn() + Send + 'static,
) -> Result<Subscription, CommandError> {
    let root = tokio::fs::canonicalize(worktree).await.map_err(error)?;
    let (send, receive) = mpsc::channel(256);
    // Full queue coalesces into a conservative invalidation; no durable data
    // travels here. Errors likewise request a refresh and are logged.
    let overflow = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let callback_overflow = overflow.clone();
    let callback_root = root.clone();
    let watch_root = root.clone();
    let watcher = tokio::task::spawn_blocking(move || {
        let mut watcher =
            notify::recommended_watcher(move |mut event: notify::Result<notify::Event>| {
                if matches!(&event, Ok(event) if matches!(event.kind, EventKind::Access(_))) {
                    return;
                }
                if let Ok(event) = &mut event {
                    let had_paths = !event.paths.is_empty();
                    event
                        .paths
                        .retain(|path| relevant_path(&callback_root, path).is_some());
                    if had_paths && event.paths.is_empty() && !event.need_rescan() {
                        return;
                    }
                }
                if send.try_send(event).is_err() {
                    callback_overflow.store(true, std::sync::atomic::Ordering::Release);
                }
            })
            .map_err(error)?;
        watcher
            .watch(&watch_root, RecursiveMode::Recursive)
            .map_err(error)?;
        Ok::<_, CommandError>(watcher)
    })
    .await
    .map_err(error)??;
    let worker = spawn_worker(root, receive, overflow, debounce, changed);
    Ok(Subscription {
        _watcher: watcher,
        worker: Some(worker),
    })
}

fn spawn_worker(
    root: PathBuf,
    mut receive: mpsc::Receiver<notify::Result<notify::Event>>,
    overflow: std::sync::Arc<std::sync::atomic::AtomicBool>,
    debounce: Duration,
    changed: impl Fn() + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(first) = receive.recv().await {
            let mut batch = vec![first];
            // Fixed window also emits during sustained writes.
            let deadline = tokio::time::Instant::now() + debounce;
            let mut saturated = false;
            loop {
                tokio::select! {
                    biased;
                    () = tokio::time::sleep_until(deadline) => break,
                    next = receive.recv() => match next {
                        Some(event) if batch.len() < 256 => batch.push(event),
                        Some(_) => saturated = true,
                        None => break,
                    }
                }
            }
            let mut uncertain =
                saturated | overflow.swap(false, std::sync::atomic::Ordering::AcqRel);
            let mut paths = Vec::new();
            for event in batch {
                match event {
                    Ok(event) => {
                        uncertain |= event.need_rescan();
                        paths.extend(
                            event
                                .paths
                                .iter()
                                .filter_map(|path| relevant_path(&root, path)),
                        );
                    }
                    Err(error) => {
                        log::warn!("worktree watch failed: {error}");
                        uncertain = true;
                    }
                }
            }
            paths.sort();
            paths.dedup();
            let visible = if paths.is_empty() {
                false
            } else {
                match has_visible_path(&root, &paths).await {
                    Ok(visible) => visible,
                    Err(error) => {
                        log::warn!("worktree ignore filtering failed: {error}");
                        true
                    }
                }
            };
            if uncertain || visible {
                changed();
            }
        }
    })
}

#[tauri::command]
#[specta::specta]
pub async fn unwatch_worktree(
    watches: State<'_, WorktreeWatches>,
    watch_id: String,
) -> Result<(), CommandError> {
    let watch = watches.0.lock().map_err(error)?.remove(&watch_id);
    if let Some(watch) = watch {
        watch.subscription.stop().await;
    }
    Ok(())
}

fn error(error: impl std::fmt::Display) -> CommandError {
    CommandError {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_writes_rename_and_delete_invalidate_but_ignored_paths_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        let (send, receive) = mpsc::channel(256);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if matches!(&event, Ok(event) if matches!(event.kind, EventKind::Access(_))) {
                    return;
                }
                let _ = send.try_send(event);
            })
            .unwrap();
        watcher.watch(&root, RecursiveMode::Recursive).unwrap();
        let (changed, mut changes) = mpsc::channel(32);
        let worker = spawn_worker(
            root.clone(),
            receive,
            Default::default(),
            Duration::from_millis(150),
            move || {
                let _ = changed.try_send(());
            },
        );
        for operation in 0..3 {
            match operation {
                0 => std::fs::write(root.join("source.rs"), "new").unwrap(),
                1 => std::fs::rename(root.join("source.rs"), root.join("renamed.rs")).unwrap(),
                _ => std::fs::remove_file(root.join("renamed.rs")).unwrap(),
            }
            tokio::time::timeout(Duration::from_secs(5), changes.recv())
                .await
                .unwrap()
                .unwrap();
        }
        // Drain delayed native batches before checking ignored-only activity.
        while matches!(
            tokio::time::timeout(Duration::from_millis(400), changes.recv()).await,
            Ok(Some(()))
        ) {}
        std::fs::write(root.join("ignored.log"), "ignored").unwrap();
        std::fs::write(root.join(".git/test-internal"), "internal").unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(500), changes.recv())
                .await
                .is_err()
        );
        drop(watcher);
        tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn bursts_coalesce_and_closed_channel_terminates_worker() {
        let dir = tempfile::tempdir().unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .status()
            .unwrap()
            .success());
        let (send, receive) = mpsc::channel(256);
        let (changed, mut changes) = mpsc::channel(32);
        let worker = spawn_worker(
            dir.path().to_owned(),
            receive,
            Default::default(),
            Duration::from_millis(150),
            move || {
                let _ = changed.try_send(());
            },
        );
        for _ in 0..50 {
            send.send(Ok(
                notify::Event::new(EventKind::Any).add_path(dir.path().join("source.rs"))
            ))
            .await
            .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(3), changes.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(changes.try_recv().is_err());
        drop(send);
        tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn filters_git_and_ignored_paths_including_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        std::fs::write(root.join(".gitignore"), "ignored/\n*.log\n!keep.log\n").unwrap();
        assert_eq!(relevant_path(root, &root.join(".git/index")), None);
        assert_eq!(relevant_path(root, &root.join("nested/.git/config")), None);
        assert!(
            !has_visible_path(root, &["ignored/deleted".into(), "gone.log".into()])
                .await
                .unwrap()
        );
        assert!(has_visible_path(root, &["keep.log".into()]).await.unwrap());
        assert!(
            has_visible_path(root, &["gone.log".into(), "source.rs".into()])
                .await
                .unwrap()
        );
        std::fs::write(root.join("tracked.log"), "tracked").unwrap();
        assert!(std::process::Command::new("git")
            .args(["add", "-f", "tracked.log"])
            .current_dir(root)
            .status()
            .unwrap()
            .success());
        assert!(has_visible_path(root, &["tracked.log".into()])
            .await
            .unwrap());
    }
}
