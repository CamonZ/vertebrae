//! Binary staging: copy a binary into the per-OS data dir, chmod +x, then
//! expose it via a symlink in `~/.local/bin`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::InstallerError;
use crate::paths::{bin_dir, data_bin_dir, symlink_path};

/// Install `source_path` as a binary named `name`.
///
/// 1. Copies `source_path` into the per-OS data dir as
///    `<data_bin_dir>/<name>`, replacing any existing file.
/// 2. On Unix, sets `0o755` permissions on the staged file.
/// 3. Creates a symlink `<bin_dir>/<name>` -> staged path, replacing any
///    existing symlink/file at that location.
///
/// Returns the path of the staged binary (the canonical install location,
/// not the symlink). Callers that need the symlink path can call
/// [`symlink_path`] directly.
pub fn install_binary(name: &str, source_path: &Path) -> Result<PathBuf, InstallerError> {
    if !source_path.exists() {
        return Err(InstallerError::SourceNotFound {
            path: source_path.to_path_buf(),
        });
    }

    let data_dir = data_bin_dir()?;
    fs::create_dir_all(&data_dir).map_err(|e| InstallerError::CreateDir {
        path: data_dir.clone(),
        reason: e.to_string(),
    })?;

    let bin_dir = bin_dir()?;
    fs::create_dir_all(&bin_dir).map_err(|e| InstallerError::CreateDir {
        path: bin_dir.clone(),
        reason: e.to_string(),
    })?;

    let staged = data_dir.join(name);
    copy_binary_to_staged_path(source_path, &staged)?;

    let link = symlink_path(name)?;
    replace_symlink(&link, &staged)?;

    Ok(staged)
}

fn copy_binary_to_staged_path(source_path: &Path, staged: &Path) -> Result<(), InstallerError> {
    let temp = temp_sibling_path(staged, "copy");
    remove_stale_temp_file(&temp)?;

    let copy_result =
        fs::copy(source_path, &temp)
            .map(|_| ())
            .map_err(|e| InstallerError::CopyBinary {
                from: source_path.to_path_buf(),
                to: staged.to_path_buf(),
                reason: e.to_string(),
            });
    if let Err(err) = copy_result {
        let _ = fs::remove_file(&temp);
        return Err(err);
    }

    if let Err(err) = set_executable(&temp) {
        let _ = fs::remove_file(&temp);
        return Err(err);
    }

    if let Err(err) = fs::rename(&temp, staged) {
        let _ = fs::remove_file(&temp);
        return Err(InstallerError::CopyBinary {
            from: source_path.to_path_buf(),
            to: staged.to_path_buf(),
            reason: format!("failed to replace staged binary: {err}"),
        });
    }

    Ok(())
}

/// Remove the symlink in `bin_dir` and the staged binary in `data_bin_dir`.
///
/// Missing files are not an error — uninstall is idempotent.
pub fn uninstall_binary(name: &str) -> Result<(), InstallerError> {
    let link = symlink_path(name)?;
    // symlink_metadata so we don't follow the link if its target was removed.
    if fs::symlink_metadata(&link).is_ok() {
        fs::remove_file(&link).map_err(|e| InstallerError::Remove {
            path: link.clone(),
            reason: e.to_string(),
        })?;
    }

    let staged = data_bin_dir()?.join(name);
    if staged.exists() {
        fs::remove_file(&staged).map_err(|e| InstallerError::Remove {
            path: staged.clone(),
            reason: e.to_string(),
        })?;
    }

    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), InstallerError> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)
        .map_err(|e| InstallerError::Chmod {
            path: path.to_path_buf(),
            reason: e.to_string(),
        })?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).map_err(|e| InstallerError::Chmod {
        path: path.to_path_buf(),
        reason: e.to_string(),
    })
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), InstallerError> {
    // On non-Unix, executability isn't a permission bit we manage.
    Ok(())
}

fn temp_sibling_path(final_path: &Path, purpose: &str) -> PathBuf {
    let parent = final_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = final_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("binary");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    parent.join(format!(
        ".{file_name}.{purpose}.{}.{}.tmp",
        std::process::id(),
        nanos
    ))
}

fn remove_stale_temp_file(path: &Path) -> Result<(), InstallerError> {
    if fs::symlink_metadata(path).is_ok() {
        fs::remove_file(path).map_err(|e| InstallerError::Remove {
            path: path.to_path_buf(),
            reason: e.to_string(),
        })?;
    }
    Ok(())
}

#[cfg(unix)]
fn replace_symlink(link: &Path, target: &Path) -> Result<(), InstallerError> {
    use std::os::unix::fs as unix_fs;

    let temp = temp_sibling_path(link, "symlink");
    remove_stale_temp_file(&temp)?;

    if let Err(err) = unix_fs::symlink(target, &temp) {
        let _ = fs::remove_file(&temp);
        return Err(InstallerError::Symlink {
            link: link.to_path_buf(),
            target: target.to_path_buf(),
            reason: err.to_string(),
        });
    }

    if let Err(err) = fs::rename(&temp, link) {
        let _ = fs::remove_file(&temp);
        return Err(InstallerError::Symlink {
            link: link.to_path_buf(),
            target: target.to_path_buf(),
            reason: err.to_string(),
        });
    }

    Ok(())
}

#[cfg(not(unix))]
fn replace_symlink(_link: &Path, _target: &Path) -> Result<(), InstallerError> {
    Err(InstallerError::UnsupportedPlatform)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Stand up an isolated HOME for the duration of the test so we exercise
    /// the real path computation without clobbering the user's `~/.local/bin`.
    struct HomeGuard {
        _tempdir: tempfile::TempDir,
        prev_home: Option<std::ffi::OsString>,
    }

    impl HomeGuard {
        fn new() -> Self {
            let tempdir = tempfile::tempdir().expect("create tempdir");
            let prev_home = std::env::var_os("HOME");
            // SAFETY: tests in this module run serially via `serial_test`.
            unsafe { std::env::set_var("HOME", tempdir.path()) };
            Self {
                _tempdir: tempdir,
                prev_home,
            }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prev_home {
                Some(v) => unsafe { std::env::set_var("HOME", v) },
                None => unsafe { std::env::remove_var("HOME") },
            }
        }
    }

    fn write_dummy_binary(dir: &Path, name: &str, body: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).expect("write dummy");
        let mut p = fs::metadata(&path).unwrap().permissions();
        p.set_mode(0o644);
        fs::set_permissions(&path, p).unwrap();
        path
    }

    #[test]
    #[serial_test::serial]
    fn install_binary_stages_and_symlinks() {
        let _home = HomeGuard::new();
        let src_dir = tempfile::tempdir().unwrap();
        let src = write_dummy_binary(src_dir.path(), "vtb-daemon", b"#!/bin/sh\necho hi\n");

        let staged = install_binary("vtb-daemon", &src).expect("install ok");

        // Staged file exists and is executable.
        let staged_meta = fs::metadata(&staged).expect("staged metadata");
        assert_eq!(
            staged_meta.permissions().mode() & 0o777,
            0o755,
            "staged binary should be 0o755, got {:o}",
            staged_meta.permissions().mode() & 0o777
        );
        assert_eq!(
            fs::read(&staged).unwrap(),
            b"#!/bin/sh\necho hi\n",
            "staged contents should match source"
        );

        // Symlink in ~/.local/bin points at the staged binary.
        let link = symlink_path("vtb-daemon").unwrap();
        let link_meta = fs::symlink_metadata(&link).expect("symlink exists");
        assert!(
            link_meta.file_type().is_symlink(),
            "expected a symlink at {link:?}"
        );
        let resolved = fs::read_link(&link).expect("read_link");
        assert_eq!(
            resolved, staged,
            "symlink target should be the staged binary"
        );
    }

    #[test]
    #[serial_test::serial]
    fn install_binary_is_idempotent_and_overwrites() {
        let _home = HomeGuard::new();
        let src_dir = tempfile::tempdir().unwrap();
        let src_v1 = write_dummy_binary(src_dir.path(), "vtb-daemon", b"v1");
        install_binary("vtb-daemon", &src_v1).expect("first install");

        let src_v2_dir = tempfile::tempdir().unwrap();
        let src_v2 = write_dummy_binary(src_v2_dir.path(), "vtb-daemon", b"v2-new-bytes");
        let staged = install_binary("vtb-daemon", &src_v2).expect("second install");

        assert_eq!(
            fs::read(&staged).unwrap(),
            b"v2-new-bytes",
            "second install should overwrite the staged binary"
        );

        let link = symlink_path("vtb-daemon").unwrap();
        assert_eq!(
            fs::read_link(&link).expect("managed symlink should exist after refresh"),
            staged,
            "refresh install should keep the managed symlink pointed at the staged binary"
        );
    }

    #[test]
    #[serial_test::serial]
    fn install_binary_preserves_existing_install_when_refresh_copy_fails() {
        let _home = HomeGuard::new();
        let src_dir = tempfile::tempdir().unwrap();
        let src_v1 = write_dummy_binary(src_dir.path(), "vtb-daemon", b"v1");
        let staged = install_binary("vtb-daemon", &src_v1).expect("first install");
        let link = symlink_path("vtb-daemon").unwrap();

        let bad_source_dir = tempfile::tempdir().unwrap();
        let err = install_binary("vtb-daemon", bad_source_dir.path())
            .expect_err("directory source should fail to copy");
        assert!(
            matches!(err, InstallerError::CopyBinary { .. }),
            "expected CopyBinary error, got {err:?}"
        );

        assert_eq!(
            fs::read(&staged).expect("existing staged binary should remain readable"),
            b"v1",
            "failed refresh must preserve the previous staged binary"
        );
        assert_eq!(
            fs::read_link(&link).expect("managed symlink should still exist"),
            staged,
            "failed refresh must preserve the previous managed symlink"
        );
    }

    #[test]
    #[serial_test::serial]
    fn install_binary_errors_when_source_missing() {
        let _home = HomeGuard::new();
        let missing = PathBuf::from("/definitely/not/here/vtb-daemon");
        let err = install_binary("vtb-daemon", &missing).expect_err("must fail");
        match err {
            InstallerError::SourceNotFound { path } => {
                assert_eq!(path, missing, "error should carry the missing path");
            }
            other => panic!("expected SourceNotFound, got {other:?}"),
        }
    }

    #[test]
    #[serial_test::serial]
    fn uninstall_binary_removes_symlink_and_staged_file() {
        let _home = HomeGuard::new();
        let src_dir = tempfile::tempdir().unwrap();
        let src = write_dummy_binary(src_dir.path(), "vtb-daemon", b"body");
        let staged = install_binary("vtb-daemon", &src).expect("install");
        let link = symlink_path("vtb-daemon").unwrap();

        assert!(staged.exists());
        assert!(fs::symlink_metadata(&link).is_ok());

        uninstall_binary("vtb-daemon").expect("uninstall");

        assert!(!staged.exists(), "staged binary should be removed");
        assert!(
            fs::symlink_metadata(&link).is_err(),
            "symlink should be removed"
        );
    }

    #[test]
    #[serial_test::serial]
    fn uninstall_binary_is_idempotent_when_nothing_installed() {
        let _home = HomeGuard::new();
        // Should not error even though nothing was ever installed.
        uninstall_binary("vtb-daemon").expect("uninstall of absent binary should be a no-op");
    }
}
