use super::{fs, CommandError, LocalChatHarnessKind, LocalChatSessionIndexEntry, Path, PathBuf};

fn queue_error() -> CommandError {
    CommandError {
        message: "Could not access the local chat queue".into(),
    }
}

fn queue_directory() -> Result<PathBuf, CommandError> {
    vertebrae_installer::data_dir()
        .map(|root| root.join("local-chat-queues"))
        .map_err(|_| queue_error())
}

/// Persist unsent input independently of the chat catalog. Catalog sync may
/// be offline or contended by another instance while a live chat is usable.
#[tauri::command]
#[specta::specta]
pub async fn save_local_chat_queue(
    session_id: String,
    session: Option<LocalChatSessionIndexEntry>,
) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        write_queue(&queue_directory()?, &session_id, session)
    })
    .await
    .map_err(|_| queue_error())?
}

fn write_queue(
    directory: &Path,
    id: &str,
    session: Option<LocalChatSessionIndexEntry>,
) -> Result<(), CommandError> {
    crate::local_chat::annotations::validate_session_id(id).map_err(|_| queue_error())?;
    let file = directory.join(format!("{id}.json"));
    let Some(session) = session else {
        return crate::private_file::remove(&file).map_err(|_| queue_error());
    };
    if session.id != id
        || session.harness != LocalChatHarnessKind::Acp
        || session.queued_messages.as_ref().is_none_or(Vec::is_empty)
    {
        return Err(queue_error());
    }
    fs::create_dir_all(directory).map_err(|_| queue_error())?;
    let bytes = serde_json::to_vec(&session).map_err(|_| queue_error())?;
    crate::private_file::replace(&file, &bytes).map_err(|_| queue_error())
}

/// Return only outstanding queues. These snapshots can restore a paused
/// conversation even when its normal catalog row is temporarily inaccessible.
#[tauri::command]
#[specta::specta]
pub async fn load_local_chat_queues() -> Result<Vec<LocalChatSessionIndexEntry>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || read_queues(&queue_directory()?))
        .await
        .map_err(|_| queue_error())?
}

fn read_queues(directory: &Path) -> Result<Vec<LocalChatSessionIndexEntry>, CommandError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(queue_error()),
    };
    Ok(entries
        .flatten()
        .filter_map(|entry| {
            if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
                return None;
            }
            let bytes = fs::read(entry.path()).ok()?;
            let session: LocalChatSessionIndexEntry = serde_json::from_slice(&bytes).ok()?;
            (session.harness == LocalChatHarnessKind::Acp
                && session
                    .queued_messages
                    .as_ref()
                    .is_some_and(|queue| !queue.is_empty())
                && entry.file_name().to_str() == Some(&format!("{}.json", session.id)))
            .then_some(session)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_queue_snapshot_recovers_and_can_be_drained_without_a_catalog() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("queues");
        let session = serde_json::from_value(serde_json::json!({
            "id": "chat-test", "label": "ACP", "harness": "acp",
            "titleUserMessageCount": 0, "messageCount": 1,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
            "projectPath": "/test", "providerResumeId": "provider-id",
            "status": "open", "lifecycle": "idle", "queuedMessages": ["first", "second"],
        }))
        .unwrap();
        write_queue(&directory, "chat-test", Some(session)).unwrap();
        let snapshots = read_queues(&directory).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            snapshots[0].provider_resume_id.as_deref(),
            Some("provider-id")
        );
        assert_eq!(
            snapshots[0].queued_messages.as_deref(),
            Some(&["first".into(), "second".into()][..])
        );
        assert!(write_queue(&directory, "../invalid", None).is_err());
        write_queue(&directory, "chat-test", None).unwrap();
        assert!(read_queues(&directory).unwrap().is_empty());
    }
}
