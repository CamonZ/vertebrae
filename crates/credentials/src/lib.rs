//! Application-owned generic credentials in macOS Keychain, Linux Secret
//! Service, or Windows Credential Manager. Config files contain UUID references.
//! This uses the current OS user's store; it does not synchronize credentials
//! across machines or provide access to Apple's Password AutoFill database.

/// Narrow storage interface. Tests inject an in-memory store and never touch
/// the user's real credentials. Errors deliberately omit backend payloads.
pub trait SecretStore: Send + Sync {
    fn read(&self, reference: &str) -> Result<String, SecretError>;
    fn write(&self, reference: &str, value: &str) -> Result<(), SecretError>;
    fn delete(&self, reference: &str) -> Result<(), SecretError>;
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SecretError {
    #[error("The stored API key is missing. Set the API key again in Settings.")]
    Missing,
    #[error(
        "The OS credential store is unavailable, locked, or access was denied. Unlock it and allow Vertebrae and its daemon to access it. On Linux, ensure Secret Service is running for this user. No plaintext fallback was used."
    )]
    Unavailable,
    #[error("Invalid API-key credential reference. Set the API key again in Settings.")]
    InvalidReference,
    #[error(
        "The OS credential store could not verify the saved API key. Settings were not changed."
    )]
    Verification,
}

pub fn new_reference() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn validate_reference(reference: &str) -> Result<(), SecretError> {
    uuid::Uuid::parse_str(reference)
        .map(|_| ())
        .map_err(|_| SecretError::InvalidReference)
}

/// Resolve an explicit OS reference before a legacy literal key. The caller
/// resolves environment overrides first. A broken reference never falls back.
pub fn resolve(
    store: &dyn SecretStore,
    reference: Option<&str>,
    legacy: Option<&str>,
) -> Result<Option<String>, SecretError> {
    match reference {
        Some(reference) => {
            validate_reference(reference)?;
            let value = store.read(reference)?;
            if value.trim().is_empty() {
                return Err(SecretError::Missing);
            }
            Ok(Some(value))
        }
        None => Ok(legacy.filter(|v| !v.trim().is_empty()).map(str::to_owned)),
    }
}

#[derive(Clone, Copy, Default)]
pub struct OsSecretStore;

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
fn entry(reference: &str) -> Result<keyring::Entry, SecretError> {
    validate_reference(reference)?;
    keyring::Entry::new("dev.vertebrae.api-keys", reference).map_err(|_| SecretError::Unavailable)
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
impl SecretStore for OsSecretStore {
    fn read(&self, reference: &str) -> Result<String, SecretError> {
        entry(reference)?
            .get_password()
            .map_err(|error| match error {
                keyring::Error::NoEntry => SecretError::Missing,
                _ => SecretError::Unavailable,
            })
    }
    fn write(&self, reference: &str, value: &str) -> Result<(), SecretError> {
        entry(reference)?
            .set_password(value)
            .map_err(|_| SecretError::Unavailable)
    }
    fn delete(&self, reference: &str) -> Result<(), SecretError> {
        match entry(reference)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(SecretError::Unavailable),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
impl SecretStore for OsSecretStore {
    fn read(&self, _: &str) -> Result<String, SecretError> {
        Err(SecretError::Unavailable)
    }
    fn write(&self, _: &str, _: &str) -> Result<(), SecretError> {
        Err(SecretError::Unavailable)
    }
    fn delete(&self, _: &str) -> Result<(), SecretError> {
        Err(SecretError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Store(Result<String, SecretError>);
    impl SecretStore for Store {
        fn read(&self, _: &str) -> Result<String, SecretError> {
            self.0.as_ref().map(Clone::clone).map_err(|e| match e {
                SecretError::Missing => SecretError::Missing,
                _ => SecretError::Unavailable,
            })
        }
        fn write(&self, _: &str, _: &str) -> Result<(), SecretError> {
            unreachable!()
        }
        fn delete(&self, _: &str) -> Result<(), SecretError> {
            unreachable!()
        }
    }
    #[test]
    fn references_win_and_missing_entries_never_fall_back_to_plaintext() {
        let id = new_reference();
        assert_eq!(
            resolve(&Store(Ok("secure-key".into())), Some(&id), Some("legacy"))
                .unwrap()
                .as_deref(),
            Some("secure-key")
        );
        assert_eq!(
            resolve(&Store(Err(SecretError::Missing)), Some(&id), Some("legacy")),
            Err(SecretError::Missing)
        );
        assert_eq!(
            resolve(
                &Store(Err(SecretError::Unavailable)),
                Some(&id),
                Some("legacy")
            ),
            Err(SecretError::Unavailable)
        );
        assert_eq!(
            resolve(&Store(Ok("".into())), Some(&id), None),
            Err(SecretError::Missing)
        );
    }
    #[test]
    fn legacy_keys_remain_supported_without_accessing_the_store() {
        assert_eq!(
            resolve(&Store(Err(SecretError::Unavailable)), None, Some("legacy"))
                .unwrap()
                .as_deref(),
            Some("legacy")
        );
        assert_eq!(
            resolve(&Store(Err(SecretError::Unavailable)), None, Some(" ")).unwrap(),
            None
        );
        assert_eq!(
            resolve(&Store(Ok("hidden".into())), Some("foreign-account"), None),
            Err(SecretError::InvalidReference)
        );
    }
}
