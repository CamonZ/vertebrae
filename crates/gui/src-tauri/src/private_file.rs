use std::{
    fs,
    io::{self, Write},
    path::Path,
};

/// Atomically replace an app-owned file with private permissions on Unix.
pub(crate) fn replace(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = parent(path)?;
    let temporary = directory.join(format!(".vtb-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        sync_directory(directory)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// Remove an app-owned file durably. A missing file is already removed.
pub(crate) fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => sync_directory(parent(path)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn parent(path: &Path) -> io::Result<&Path> {
    path.parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent directory"))
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> io::Result<()> {
    fs::File::open(directory)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_and_removes_private_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("transcript.json");
        replace(&path, b"first").unwrap();
        replace(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        remove(&path).unwrap();
        remove(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn failed_replace_removes_its_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        fs::create_dir(&target).unwrap();
        assert!(replace(&target, b"data").is_err());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
