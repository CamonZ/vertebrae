//! Daemon configuration and protected standalone identity storage.
//!
//! The account-authenticated daemon continues to use the shared
//! `config.toml`. Standalone enrollment is kept in a separate `daemon.toml`
//! so GUI/CLI account configuration writes cannot replace its stable identity.

use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use vertebrae_sacrum_client::{VertebraeConfigFile, config_path, load_config_file};

const DAEMON_CONFIG_FILENAME: &str = "daemon.toml";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Failed to load config file: {0}")]
    LoadFailed(String),
    #[error("Missing required configuration: {0}")]
    Missing(String),
    #[error("Daemon is already enrolled as {daemon_id}; use explicit credential re-enrollment")]
    AlreadyEnrolled { daemon_id: String },
    #[error("Cannot replace enrolled daemon {existing_id} with a different identity")]
    IdentityMismatch { existing_id: String },
    #[error("Failed to persist daemon configuration: {0}")]
    PersistFailed(String),
}

#[derive(Clone, PartialEq, Eq)]
pub struct DaemonIdentity {
    pub endpoint: String,
    pub daemon_id: String,
    pub reconnect_token: String,
    pub expires_at: String,
}

#[derive(Deserialize, Serialize)]
struct PersistedDaemonIdentity {
    endpoint: String,
    daemon_id: String,
    reconnect_token: String,
    expires_at: String,
}

impl From<PersistedDaemonIdentity> for DaemonIdentity {
    fn from(value: PersistedDaemonIdentity) -> Self {
        Self {
            endpoint: value.endpoint,
            daemon_id: value.daemon_id,
            reconnect_token: value.reconnect_token,
            expires_at: value.expires_at,
        }
    }
}

impl From<&DaemonIdentity> for PersistedDaemonIdentity {
    fn from(value: &DaemonIdentity) -> Self {
        Self {
            endpoint: value.endpoint.clone(),
            daemon_id: value.daemon_id.clone(),
            reconnect_token: value.reconnect_token.clone(),
            expires_at: value.expires_at.clone(),
        }
    }
}

impl fmt::Debug for DaemonIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DaemonIdentity")
            .field("endpoint", &self.endpoint)
            .field("daemon_id", &self.daemon_id)
            .field("reconnect_token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// A project entry with its Sacrum ID and local path.
#[derive(Debug, Clone)]
pub struct ProjectEntry {
    /// Project slug (the key in `[projects.<name>]`).
    pub slug: String,
    /// Sacrum project ID (UUID).
    pub project_id: String,
    /// Git root path for the project.
    pub path: String,
}

#[derive(Clone)]
pub struct ResolvedConfig {
    pub sacrum_url: String,
    pub api_token: Option<String>,
    pub daemon_identity: Option<DaemonIdentity>,
    pub projects: Vec<ProjectEntry>,
}

impl fmt::Debug for ResolvedConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResolvedConfig")
            .field("sacrum_url", &self.sacrum_url)
            .field("api_token", &self.api_token.as_ref().map(|_| "<redacted>"))
            .field("daemon_identity", &self.daemon_identity)
            .field("projects", &self.projects)
            .finish()
    }
}

pub fn daemon_config_path() -> Result<PathBuf, ConfigError> {
    config_path()
        .and_then(|path| {
            path.parent()
                .map(|parent| parent.join(DAEMON_CONFIG_FILENAME))
        })
        .ok_or_else(|| ConfigError::LoadFailed("could not determine config directory".to_string()))
}

pub fn load_daemon_identity() -> Result<Option<DaemonIdentity>, ConfigError> {
    load_daemon_identity_at(&daemon_config_path()?)
}

fn load_daemon_identity_at(path: &Path) -> Result<Option<DaemonIdentity>, ConfigError> {
    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(path).map_err(|error| {
        ConfigError::LoadFailed(format!("failed to read daemon config: {error}"))
    })?;
    let identity: DaemonIdentity = toml::from_str::<PersistedDaemonIdentity>(&content)
        .map_err(|error| {
            // Parser messages and source excerpts can both contain credentials.
            let location = error
                .span()
                .map(|span| format!(" at byte {}", span.start))
                .unwrap_or_default();
            ConfigError::LoadFailed(format!("failed to parse daemon config{location}"))
        })?
        .into();
    let endpoint = url::Url::parse(&identity.endpoint)
        .map_err(|error| ConfigError::LoadFailed(format!("invalid daemon endpoint: {error}")))?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || !crate::phoenix::endpoint_allows_cleartext(&endpoint)
    {
        return Err(ConfigError::LoadFailed(
            "daemon endpoint must use HTTPS, except for loopback HTTP".to_string(),
        ));
    }
    Ok(Some(identity))
}

/// Owns the enrollment transaction, including the remote one-time exchange.
/// The persistent lock file must not be removed: all writers lock the same inode.
/// Its parent is the user's trusted, owner-only configuration directory.
pub struct DaemonEnrollmentStorage {
    path: PathBuf,
    daemon_id: String,
    replace_existing: bool,
    lock: std::fs::File,
}

impl Drop for DaemonEnrollmentStorage {
    fn drop(&mut self) {
        // Explicit unlock also releases the lock if a concurrent fork inherited
        // a descriptor before exec. File drop alone can leave that copy locked.
        let _ = self.lock.unlock();
    }
}

impl DaemonEnrollmentStorage {
    pub fn begin(daemon_id: &str, replace_existing: bool) -> Result<Self, ConfigError> {
        Self::begin_at(&daemon_config_path()?, daemon_id, replace_existing)
    }

    fn begin_at(path: &Path, daemon_id: &str, replace_existing: bool) -> Result<Self, ConfigError> {
        let parent = path.parent().ok_or_else(|| {
            ConfigError::PersistFailed("daemon config has no parent directory".to_string())
        })?;
        std::fs::create_dir_all(parent).map_err(|error| {
            ConfigError::PersistFailed(format!("create config directory: {error}"))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(
                |error| ConfigError::PersistFailed(format!("protect config directory: {error}")),
            )?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(parent.join("daemon.lock")).map_err(|error| {
            ConfigError::PersistFailed(format!("open enrollment lock: {error}"))
        })?;
        lock.try_lock().map_err(|error| {
            ConfigError::PersistFailed(format!(
                "cannot lock enrollment; another enrollment may be running: {error}"
            ))
        })?;
        let storage = Self {
            path: path.to_owned(),
            daemon_id: daemon_id.to_owned(),
            replace_existing,
            lock,
        };
        if let Some(existing) = load_daemon_identity_at(path)? {
            if !replace_existing {
                return Err(ConfigError::AlreadyEnrolled {
                    daemon_id: existing.daemon_id,
                });
            }
            if existing.daemon_id != daemon_id {
                return Err(ConfigError::IdentityMismatch {
                    existing_id: existing.daemon_id,
                });
            }
        }
        Ok(storage)
    }

    pub fn save(self, identity: &DaemonIdentity) -> Result<(), ConfigError> {
        if identity.daemon_id != self.daemon_id {
            return Err(ConfigError::IdentityMismatch {
                existing_id: self.daemon_id.clone(),
            });
        }
        write_daemon_identity(&self.path, identity, self.replace_existing)
    }
}

pub fn save_daemon_identity(
    identity: &DaemonIdentity,
    replace_existing: bool,
) -> Result<(), ConfigError> {
    DaemonEnrollmentStorage::begin(&identity.daemon_id, replace_existing)?.save(identity)
}

#[cfg(test)]
fn save_daemon_identity_at(
    path: &Path,
    identity: &DaemonIdentity,
    replace_existing: bool,
) -> Result<(), ConfigError> {
    DaemonEnrollmentStorage::begin_at(path, &identity.daemon_id, replace_existing)?.save(identity)
}

fn write_daemon_identity(
    path: &Path,
    identity: &DaemonIdentity,
    replace_existing: bool,
) -> Result<(), ConfigError> {
    let parent = path.parent().ok_or_else(|| {
        ConfigError::PersistFailed("daemon config has no parent directory".to_string())
    })?;
    let content = toml::to_string_pretty(&PersistedDaemonIdentity::from(identity))
        .map_err(|error| ConfigError::PersistFailed(format!("serialize daemon config: {error}")))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|error| {
        ConfigError::PersistFailed(format!("create temporary daemon config: {error}"))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                ConfigError::PersistFailed(format!("protect temporary daemon config: {error}"))
            })?;
    }
    temp.write_all(content.as_bytes())
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|error| ConfigError::PersistFailed(format!("write daemon config: {error}")))?;
    let activated = if replace_existing {
        temp.persist(path)
    } else {
        temp.persist_noclobber(path)
    };
    activated.map_err(|error| {
        ConfigError::PersistFailed(format!("activate daemon config: {}", error.error))
    })?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            ConfigError::PersistFailed(format!(
                "daemon config activated but directory sync failed: {error}"
            ))
        })?;
    Ok(())
}

impl ResolvedConfig {
    pub fn load() -> Result<Self, ConfigError> {
        let config = load_config_file().map_err(|e| ConfigError::LoadFailed(e.to_string()))?;
        let identity = load_daemon_identity()?;
        Self::from_config_file_and_identity(&config, identity)
    }

    pub fn from_config_file(config: &VertebraeConfigFile) -> Result<Self, ConfigError> {
        Self::from_config_file_and_identity(config, None)
    }

    pub fn from_config_file_and_identity(
        config: &VertebraeConfigFile,
        daemon_identity: Option<DaemonIdentity>,
    ) -> Result<Self, ConfigError> {
        if daemon_identity.is_none() && config.sacrum.token.is_none() {
            return Err(ConfigError::Missing(
                "API token not found. Set [sacrum].token in ~/.config/vertebrae/config.toml or enroll this daemon"
                    .to_string(),
            ));
        }

        let projects = config
            .projects
            .iter()
            .map(|(slug, section)| ProjectEntry {
                slug: slug.clone(),
                project_id: section.id.clone(),
                path: section.path.clone(),
            })
            .collect();
        let sacrum_url = daemon_identity
            .as_ref()
            .map(|identity| identity.endpoint.clone())
            .unwrap_or_else(|| config.sacrum.url.clone());

        Ok(ResolvedConfig {
            sacrum_url,
            api_token: config.sacrum.token.clone(),
            daemon_identity,
            projects,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::tempdir;
    use vertebrae_sacrum_client::{GlobalSacrumSection, ProjectSection};

    fn config(token: Option<&str>) -> VertebraeConfigFile {
        VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "https://sacrum.example.com".to_string(),
                token: token.map(str::to_string),
            },
            projects: BTreeMap::from([(
                "vertebrae".to_string(),
                ProjectSection {
                    id: "proj-1".to_string(),
                    path: "/home/user/vertebrae".to_string(),
                },
            )]),
        }
    }

    fn identity(id: &str, token: &str) -> DaemonIdentity {
        DaemonIdentity {
            endpoint: "https://sacrum.example.com/base".to_string(),
            daemon_id: id.to_string(),
            reconnect_token: token.to_string(),
            expires_at: "2026-09-07T12:00:00Z".to_string(),
        }
    }

    #[test]
    fn standalone_identity_does_not_require_account_token() {
        let resolved = ResolvedConfig::from_config_file_and_identity(
            &config(None),
            Some(identity("daemon-1", "secret")),
        )
        .unwrap();
        assert_eq!(resolved.api_token, None);
        assert_eq!(resolved.sacrum_url, "https://sacrum.example.com/base");
        assert_eq!(resolved.projects.len(), 1);
    }

    #[test]
    fn missing_authentication_is_rejected() {
        let error = ResolvedConfig::from_config_file(&config(None)).unwrap_err();
        assert!(error.to_string().contains("enroll this daemon"));
    }

    #[test]
    fn identity_debug_redacts_reconnect_token() {
        let identity = identity("daemon-1", "do-not-log");
        let debug = format!("{identity:?}");
        assert!(!debug.contains("do-not-log"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn identity_write_is_atomic_protected_and_duplicate_safe() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("daemon.toml");
        let first = identity("daemon-1", "first-secret");
        save_daemon_identity_at(&path, &first, false).unwrap();
        assert_eq!(load_daemon_identity_at(&path).unwrap(), Some(first.clone()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let duplicate =
            save_daemon_identity_at(&path, &identity("daemon-1", "second-secret"), false)
                .unwrap_err();
        assert!(matches!(duplicate, ConfigError::AlreadyEnrolled { .. }));
        save_daemon_identity_at(&path, &identity("daemon-1", "second-secret"), true).unwrap();
        assert_eq!(
            load_daemon_identity_at(&path)
                .unwrap()
                .unwrap()
                .reconnect_token,
            "second-secret"
        );
    }

    #[test]
    fn different_identity_cannot_replace_existing_config() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        save_daemon_identity_at(&path, &identity("daemon-1", "secret"), false).unwrap();
        let error =
            save_daemon_identity_at(&path, &identity("daemon-2", "other"), true).unwrap_err();
        assert!(
            matches!(error, ConfigError::IdentityMismatch { .. }),
            "{error}"
        );
    }

    #[test]
    fn corrupt_identity_is_not_replaced() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        std::fs::write(&path, "not = [valid").unwrap();
        let error =
            save_daemon_identity_at(&path, &identity("daemon-1", "secret"), true).unwrap_err();
        assert!(error.to_string().contains("failed to parse daemon config"));
    }
    #[test]
    fn malformed_secret_diagnostics_never_echo_input() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        for content in [
            "reconnect_token = \"PRIVATE-CREDENTIAL\" trailing",
            "reconnect_token = [\"PRIVATE-CREDENTIAL\"]",
        ] {
            std::fs::write(&path, content).unwrap();
            let error = load_daemon_identity_at(&path).unwrap_err();
            assert!(!format!("{error:?}: {error}").contains("PRIVATE-CREDENTIAL"));
            assert!(error.to_string().contains("failed to parse daemon config"));
        }
    }

    #[test]
    fn enrollment_lock_covers_exchange_and_is_released_on_failure() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        let transaction = DaemonEnrollmentStorage::begin_at(&path, "daemon-1", false).unwrap();
        let other_path = path.clone();
        let competing = std::thread::spawn(move || {
            save_daemon_identity_at(&other_path, &identity("daemon-2", "other"), false)
        })
        .join()
        .unwrap();
        assert!(competing.is_err());
        assert!(!path.exists(), "neither exchange has committed");
        drop(transaction); // Exchange failed: permit a later explicit retry.
        save_daemon_identity_at(&path, &identity("daemon-2", "other"), false).unwrap();
    }

    #[test]
    fn concurrent_first_enrollments_cannot_replace_each_other() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daemon.toml");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let writers: Vec<_> = ["daemon-1", "daemon-2"]
            .into_iter()
            .map(|id| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    (
                        id,
                        save_daemon_identity_at(&path, &identity(id, "secret"), false),
                    )
                })
            })
            .collect();
        let results: Vec<_> = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect();
        let winners: Vec<_> = results
            .iter()
            .filter(|(_, result)| result.is_ok())
            .collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(
            load_daemon_identity_at(&path).unwrap().unwrap().daemon_id,
            winners[0].0
        );
    }
}
