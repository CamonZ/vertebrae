//! Immutable, keyed history records. Large bodies stay on disk; JSONL and IPC
//! carry only small headers. A session lock coordinates publication and deletion.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PublishOutcome {
    Written,
    Existing,
    Deleted,
    Expired,
}

struct Staged(PathBuf);
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

impl LocalChatAnnotationStore {
    fn record_paths(
        &self,
        session: &str,
        kind: &str,
        subject: &AnnotationSubject,
    ) -> Result<(PathBuf, PathBuf), AnnotationStoreError> {
        validate_session_id(session)?;
        let identity = serde_json::to_vec(&(kind, subject))
            .map_err(|e| AnnotationStoreError::InvalidAnnotation(e.to_string()))?;
        let key = format!("{:x}", Sha256::digest(identity));
        let directory = self.directory()?.join(format!("{session}.records"));
        Ok((
            directory.join(format!("{key}.header.json")),
            directory.join(format!("{key}.body.json")),
        ))
    }

    fn staged(&self, directory: &Path, bytes: &[u8]) -> Result<Staged, AnnotationStoreError> {
        if bytes.len() > MAX_ANNOTATION_LINE_BYTES {
            return Err(AnnotationStoreError::TooLarge { bytes: bytes.len() });
        }
        fs::create_dir_all(directory).map_err(io_error)?;
        let path = directory.join(format!("{}.pending", uuid::Uuid::new_v4()));
        let staged = Staged(path.clone());
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(io_error)?;
        file.write_all(bytes)
            .and_then(|()| file.flush())
            .map_err(io_error)?;
        Ok(staged)
    }

    /// The validity callback is checked after preparation and after activation,
    /// while readers are excluded. Expiry commits an unavailable record instead.
    pub(crate) fn publish_record(
        &self,
        annotation: LocalChatAnnotation,
        expired: Option<LocalChatAnnotation>,
        valid: impl Fn() -> bool,
    ) -> Result<PublishOutcome, AnnotationStoreError> {
        self.publish_record_inner(annotation, expired, valid, true)
    }

    pub(super) fn publish_record_inner(
        &self,
        annotation: LocalChatAnnotation,
        expired: Option<LocalChatAnnotation>,
        valid: impl Fn() -> bool,
        notify: bool,
    ) -> Result<PublishOutcome, AnnotationStoreError> {
        validate_annotation(&annotation)?;
        if expired.as_ref().is_some_and(|entry| {
            entry.session_id != annotation.session_id
                || entry.kind != annotation.kind
                || entry.subject != annotation.subject
        }) {
            return Err(AnnotationStoreError::InvalidAnnotation(
                "expiry record must preserve capture identity".into(),
            ));
        }
        let subject = annotation.subject.as_ref().ok_or_else(|| {
            AnnotationStoreError::InvalidAnnotation("history requires a subject".into())
        })?;
        let (header, body) =
            self.record_paths(&annotation.session_id, &annotation.kind, subject)?;
        let directory = header.parent().ok_or_else(|| {
            AnnotationStoreError::InvalidAnnotation("missing record directory".into())
        })?;
        let bytes = serde_json::to_vec(&annotation.payload)
            .map_err(|e| AnnotationStoreError::InvalidAnnotation(e.to_string()))?;
        let staged_body = self.staged(directory, &bytes)?;
        let projected = annotation.frontend();
        if serde_json::to_vec(&projected)
            .map_err(|e| AnnotationStoreError::InvalidAnnotation(e.to_string()))?
            .len()
            > 16 * 1024
        {
            return Err(AnnotationStoreError::TooLarge {
                bytes: 16 * 1024 + 1,
            });
        }
        let staged_header = self.staged(
            directory,
            &serde_json::to_vec(&projected)
                .map_err(|e| AnnotationStoreError::InvalidAnnotation(e.to_string()))?,
        )?;
        let fallback = expired
            .map(|entry| {
                let body = self.staged(
                    directory,
                    &serde_json::to_vec(&entry.payload)
                        .map_err(|e| AnnotationStoreError::InvalidAnnotation(e.to_string()))?,
                )?;
                let projected = entry.frontend();
                let header = self.staged(
                    directory,
                    &serde_json::to_vec(&projected)
                        .map_err(|e| AnnotationStoreError::InvalidAnnotation(e.to_string()))?,
                )?;
                Ok::<_, AnnotationStoreError>((body, header, projected))
            })
            .transpose()?;
        let lock = self.session_lock(&annotation.session_id);
        let guard = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self
            .session_path(&annotation.session_id)?
            .with_extension("deleted")
            .try_exists()
            .map_err(io_error)?
        {
            return Ok(PublishOutcome::Deleted);
        }
        if header.try_exists().map_err(io_error)? {
            return Ok(PublishOutcome::Existing);
        }
        let mut timed_out = !valid();
        if timed_out && fallback.is_none() {
            return Ok(PublishOutcome::Expired);
        }
        // Recover an uncommitted body left by an interrupted publication. A
        // committed header is never replaced, even after restart/load failure.
        remove_if_present(&body).map_err(io_error)?;
        let activate = |b: &Staged, h: &Staged| -> Result<(), AnnotationStoreError> {
            fs::hard_link(&b.0, &body).map_err(io_error)?;
            if let Err(error) = fs::hard_link(&h.0, &header) {
                let _ = fs::remove_file(&body);
                return Err(io_error(error));
            }
            Ok(())
        };
        let selected = if timed_out {
            let (b, h, entry) = fallback.as_ref().ok_or_else(|| {
                AnnotationStoreError::InvalidAnnotation("missing expiry record".into())
            })?;
            activate(b, h)?;
            entry.clone()
        } else {
            activate(&staged_body, &staged_header)?;
            if !valid() {
                fs::remove_file(&header).map_err(io_error)?;
                fs::remove_file(&body).map_err(io_error)?;
                timed_out = true;
                if let Some((b, h, entry)) = &fallback {
                    activate(b, h)?;
                    entry.clone()
                } else {
                    return Ok(PublishOutcome::Expired);
                }
            } else {
                projected
            }
        };
        drop(guard);
        if notify {
            self.emit_annotation(selected);
        }
        Ok(if timed_out {
            PublishOutcome::Expired
        } else {
            PublishOutcome::Written
        })
    }

    /// Retention ownership must be recorded before creating a Git ref, and
    /// creation must serialize with deletion of that ownership record.
    pub(crate) fn while_session_live<T>(
        &self,
        session: &str,
        action: impl FnOnce() -> T,
    ) -> Result<Option<T>, AnnotationStoreError> {
        let path = self.session_path(session)?;
        let lock = self.session_lock(session);
        let _guard = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if path
            .with_extension("deleted")
            .try_exists()
            .map_err(io_error)?
        {
            return Ok(None);
        }
        Ok(Some(action()))
    }

    pub(crate) fn record_exists(
        &self,
        session: &str,
        kind: &str,
        subject: &AnnotationSubject,
    ) -> Result<bool, AnnotationStoreError> {
        let lock = self.session_lock(session);
        let _guard = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (header, _) = self.record_paths(session, kind, subject)?;
        header.try_exists().map_err(io_error)
    }

    pub(crate) fn read_record(
        &self,
        session: &str,
        kind: &str,
        subject: &AnnotationSubject,
    ) -> Result<Option<serde_json::Value>, AnnotationStoreError> {
        let lock = self.session_lock(session);
        let _guard = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self
            .session_path(session)?
            .with_extension("deleted")
            .try_exists()
            .map_err(io_error)?
        {
            return Ok(None);
        }
        let (header, body) = self.record_paths(session, kind, subject)?;
        if !header.try_exists().map_err(io_error)? {
            return Ok(None);
        }
        let bytes = bounded_read(&body, MAX_ANNOTATION_LINE_BYTES)?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| AnnotationStoreError::InvalidAnnotation(e.to_string()))
    }

    pub(super) fn record_headers(
        &self,
        session: &str,
    ) -> Result<Vec<LocalChatAnnotation>, AnnotationStoreError> {
        validate_session_id(session)?;
        let directory = self.directory()?.join(format!("{session}.records"));
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(io_error(e)),
        };
        let mut headers = vec![];
        for entry in entries {
            let path = entry.map_err(io_error)?.path();
            if !path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().ends_with(".header.json"))
            {
                continue;
            }
            let header: LocalChatAnnotation =
                match bounded_read(&path, 16 * 1024).and_then(|bytes| {
                    serde_json::from_slice(&bytes)
                        .map_err(|e| AnnotationStoreError::InvalidAnnotation(e.to_string()))
                }) {
                    Ok(header) => header,
                    Err(error) => {
                        log::warn!(
                            "[LOCAL_CHAT] skipping damaged history header {}: {error}",
                            path.display()
                        );
                        continue;
                    }
                };
            if header.session_id == session {
                headers.push(header);
            }
        }
        Ok(headers)
    }

    pub(super) fn remove_records(&self, session: &str) -> Result<(), AnnotationStoreError> {
        let directory = self.directory()?.join(format!("{session}.records"));
        match fs::remove_dir_all(directory) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error(e)),
        }
    }
}

fn bounded_read(path: &Path, limit: usize) -> Result<Vec<u8>, AnnotationStoreError> {
    let mut bytes = vec![];
    File::open(path)
        .map_err(io_error)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > limit {
        return Err(AnnotationStoreError::TooLarge { bytes: bytes.len() });
    }
    Ok(bytes)
}
fn io_error(error: std::io::Error) -> AnnotationStoreError {
    AnnotationStoreError::Io(error.to_string())
}
