//! Stable installation identity shared by upgraded and freshly installed clients.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use uuid::Uuid;

use crate::{InstallerError, data_dir};

// Preserve the identity provisioned by the first chat-catalog client release.
const IDENTITY_FILE: &str = "chat-installation-id";

/// Return this installation's stable UUID, provisioning it for older installs.
/// Reinstalling binaries or rotating API credentials must not change this ID.
pub fn installation_id() -> Result<String, InstallerError> {
    installation_id_in(&data_dir()?)
}

/// Provision identity in an explicitly selected, trusted application data directory.
/// The directory is owned by this user; this is not a hostile-directory API.
/// A fully synced temporary inode is published with an exclusive hard link, so
/// concurrent installers cannot observe partially written IDs or replace a winner.
pub fn installation_id_in(root: &Path) -> Result<String, InstallerError> {
    provision(root).map_err(|error| InstallerError::InstallationIdentity {
        reason: error.to_string(),
    })
}

fn read_identity(path: &Path) -> io::Result<String> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > 64 {
        return Err(io::Error::other(
            "installation identity is not a regular file",
        ));
    }

    let id = fs::read_to_string(path)?;
    Uuid::parse_str(id.trim())
        .map(|id| id.to_string())
        .map_err(|_| io::Error::other("installation identity is invalid; refusing to replace it"))
}

fn provision(root: &Path) -> io::Result<String> {
    fs::create_dir_all(root)?;
    let path = root.join(IDENTITY_FILE);
    match read_identity(&path) {
        Ok(id) => return Ok(id),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let id = Uuid::new_v4().to_string();
    let temporary = root.join(format!(".installation-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(id.as_bytes())?;
        file.sync_all()?;

        match fs::hard_link(&temporary, &path) {
            Ok(()) => File::open(root)?.sync_all(),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        }?;
        read_identity(&path)
    })();

    // Only remove our own staging inode, including on a failed publication.
    let _ = fs::remove_file(temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_reuse_existing_identity_and_corruption_never_rotates_it() {
        let root = tempfile::tempdir().unwrap();
        let original = Uuid::new_v4().to_string();
        let path = root.path().join(IDENTITY_FILE);
        fs::write(&path, &original).unwrap();
        assert_eq!(installation_id_in(root.path()).unwrap(), original);

        fs::write(&path, "corrupt").unwrap();
        assert!(installation_id_in(root.path()).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "corrupt");
    }

    #[test]
    fn concurrent_installers_publish_one_complete_identity() {
        let root = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let root = root.path().to_path_buf();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    installation_id_in(&root).unwrap()
                })
            })
            .collect();
        let ids: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}
