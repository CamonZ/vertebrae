//! Coordinate validated config changes with immutable OS credential entries.
//! Write and verify the new entry before publishing its reference. Never
//! overwrite an existing entry: a config conflict must retain the working key.
use vertebrae_core::ProviderId;
use vertebrae_credentials::{new_reference, SecretStore};
use vertebrae_sacrum_client::VertebraeConfigFile;

use super::{apply, invalid, CommandError, SecretEdit, SettingsEdit};

enum Target {
    Typesafe,
    Provider(ProviderId),
}

fn target(edit: &SettingsEdit) -> Result<Option<(Target, &SecretEdit)>, CommandError> {
    match edit {
        SettingsEdit::Typesafe { key, .. } => Ok(Some((Target::Typesafe, key))),
        SettingsEdit::Provider { id, key, .. } => Ok(Some((
            Target::Provider(ProviderId::new(id).map_err(|_| invalid("Invalid provider ID."))?),
            key,
        ))),
        _ => Ok(None),
    }
}
fn slot<'a>(
    config: &'a mut VertebraeConfigFile,
    target: &Target,
) -> Result<(&'a mut Option<String>, &'a mut Option<String>), CommandError> {
    match target {
        Target::Typesafe => Ok((
            &mut config.typesafe.api_key,
            &mut config.typesafe.api_key_secret,
        )),
        Target::Provider(id) => {
            let profile = config
                .providers
                .get_mut(id)
                .ok_or_else(|| invalid("Provider no longer exists. Reload Settings."))?;
            Ok((&mut profile.api_key, &mut profile.api_key_secret))
        }
    }
}
fn uses_reference(config: &VertebraeConfigFile, reference: &str) -> bool {
    config.typesafe.api_key_secret.as_deref() == Some(reference)
        || config
            .providers
            .values()
            .any(|profile| profile.api_key_secret.as_deref() == Some(reference))
}

/// `read_after_failure` distinguishes a failed pre-activation write from an
/// uncertain post-activation result. In the latter case retain the new secret;
/// an unreferenced orphan is safer than deleting a possibly active credential.
pub(super) fn apply_and_persist(
    config: &mut VertebraeConfigFile,
    edit: SettingsEdit,
    store: &dyn SecretStore,
    persist: impl FnOnce(&VertebraeConfigFile) -> Result<(), CommandError>,
    read_after_failure: impl FnOnce() -> Option<VertebraeConfigFile>,
) -> Result<Option<String>, CommandError> {
    let change = target(&edit)?;
    let old_reference = match &change {
        Some((target, _)) => slot(config, target)
            .ok()
            .and_then(|(_, reference)| reference.clone()),
        None => None,
    };
    apply(config, edit.clone())?;
    let mut created = None;
    let mut retire = false;
    if let Some((target, key_edit)) = change {
        let (literal, reference) = slot(config, &target)?;
        match key_edit {
            SecretEdit::Keep => (),
            SecretEdit::Clear => {
                *literal = None;
                *reference = None;
                retire = true;
            }
            SecretEdit::Replace(_) | SecretEdit::Migrate => {
                let value = literal
                    .as_deref()
                    .filter(|key| !key.trim().is_empty())
                    .ok_or_else(|| {
                        invalid("No plaintext API key is available to move. Enter a new API key.")
                    })?;
                if value.len() > 16 * 1024 {
                    return Err(invalid("The API key is too long (maximum 16 KiB)."));
                }
                let id = new_reference();
                if let Err(error) = store.write(&id, value) {
                    let _ = store.delete(&id);
                    return Err(invalid(&error.to_string()));
                }
                match store.read(&id) {
                    Ok(saved) if saved == value => (),
                    _ => {
                        let cleanup = store.delete(&id);
                        return Err(invalid(if cleanup.is_err() {
                            "The OS store could not verify the key or remove its staged entry. Settings were not changed; check your OS credential manager."
                        } else {
                            "The OS store could not verify the API key. Settings were not changed."
                        }));
                    }
                }
                *reference = Some(id.clone());
                *literal = None;
                created = Some(id);
                retire = true;
            }
        }
    }
    if let Err(error) = persist(config) {
        if let Some(id) = created {
            if read_after_failure()
                .as_ref()
                .is_some_and(|saved| !uses_reference(saved, &id))
                && store.delete(&id).is_err()
            {
                return Err(invalid("Settings were not saved and the staged OS credential could not be removed. Reload settings and check your OS credential manager."));
            }
        }
        return Err(error);
    }
    if retire {
        if let Some(old) = old_reference.filter(|id| !uses_reference(config, id)) {
            if store.delete(&old).is_err() {
                return Ok(Some("Settings were saved, but the previous OS credential could not be removed. Remove obsolete Vertebrae API-key entries in your OS credential manager.".into()));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, sync::Mutex};
    use vertebrae_credentials::SecretError;
    #[derive(Default)]
    struct Store {
        values: Mutex<BTreeMap<String, String>>,
        locked: bool,
        corrupt_read: bool,
        fail_delete: bool,
    }
    impl SecretStore for Store {
        fn read(&self, id: &str) -> Result<String, SecretError> {
            if self.locked {
                return Err(SecretError::Unavailable);
            }
            if self.corrupt_read {
                return Ok("unexpected-value".into());
            }
            self.values
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or(SecretError::Missing)
        }
        fn write(&self, id: &str, value: &str) -> Result<(), SecretError> {
            if self.locked {
                return Err(SecretError::Unavailable);
            }
            self.values.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), SecretError> {
            if self.locked {
                return Err(SecretError::Unavailable);
            }
            if self.fail_delete {
                return Err(SecretError::Unavailable);
            }
            self.values.lock().unwrap().remove(id);
            Ok(())
        }
    }
    fn edit(key: SecretEdit) -> SettingsEdit {
        SettingsEdit::Typesafe {
            url: String::new(),
            key,
        }
    }
    #[test]
    fn replacement_stores_only_a_reference_and_preserves_other_settings() {
        let store = Store::default();
        let mut config = VertebraeConfigFile::default();
        config.sacrum.token = Some("untouched".into());
        apply_and_persist(
            &mut config,
            edit(SecretEdit::Replace("test-key".into())),
            &store,
            |saved| {
                let text = serde_json::to_string(saved).unwrap();
                assert!(!text.contains("test-key"));
                assert!(text.contains("api_key_secret"));
                Ok(())
            },
            || None,
        )
        .unwrap();
        assert_eq!(
            store
                .read(config.typesafe.api_key_secret.as_deref().unwrap())
                .unwrap(),
            "test-key"
        );
        assert_eq!(config.sacrum.token.as_deref(), Some("untouched"));
    }
    #[test]
    fn migration_removes_plaintext_only_after_successful_store_and_config_write() {
        let store = Store::default();
        let mut config = VertebraeConfigFile::default();
        config.typesafe.api_key = Some("legacy".into());
        apply_and_persist(
            &mut config,
            edit(SecretEdit::Migrate),
            &store,
            |saved| {
                assert!(saved.typesafe.api_key.is_none());
                Ok(())
            },
            || None,
        )
        .unwrap();
        assert_eq!(
            store
                .read(config.typesafe.api_key_secret.as_deref().unwrap())
                .unwrap(),
            "legacy"
        );
    }
    #[test]
    fn failed_config_write_removes_staged_key_and_retains_original_key() {
        let store = Store::default();
        let old = new_reference();
        store.write(&old, "original").unwrap();
        let mut config = VertebraeConfigFile::default();
        config.typesafe.api_key_secret = Some(old.clone());
        let original = config.clone();
        assert!(apply_and_persist(
            &mut config,
            edit(SecretEdit::Replace("replacement".into())),
            &store,
            |_| Err(invalid("Conflict")),
            || Some(original)
        )
        .is_err());
        assert_eq!(store.read(&old).unwrap(), "original");
        assert_eq!(store.values.lock().unwrap().len(), 1);
    }
    #[test]
    fn locked_store_fails_without_plaintext_fallback_or_config_write() {
        let store = Store {
            locked: true,
            ..Default::default()
        };
        let mut config = VertebraeConfigFile::default();
        config.typesafe.api_key = Some("legacy".into());
        assert!(apply_and_persist(
            &mut config,
            edit(SecretEdit::Migrate),
            &store,
            |_| panic!("must not save"),
            || None
        )
        .is_err());
        assert_eq!(config.typesafe.api_key.as_deref(), Some("legacy"));
    }
    #[test]
    fn clearing_removes_os_key_only_after_config_is_saved() {
        let store = Store::default();
        let old = new_reference();
        store.write(&old, "original").unwrap();
        let mut config = VertebraeConfigFile::default();
        config.typesafe.api_key_secret = Some(old.clone());
        apply_and_persist(
            &mut config,
            edit(SecretEdit::Clear),
            &store,
            |saved| {
                assert!(saved.typesafe.api_key_secret.is_none());
                assert_eq!(store.read(&old).unwrap(), "original");
                Ok(())
            },
            || None,
        )
        .unwrap();
        assert_eq!(store.read(&old), Err(SecretError::Missing));
    }
    #[test]
    fn verification_failure_never_publishes_a_reference() {
        let store = Store {
            corrupt_read: true,
            ..Default::default()
        };
        let mut config = VertebraeConfigFile::default();
        assert!(apply_and_persist(
            &mut config,
            edit(SecretEdit::Replace("new-key".into())),
            &store,
            |_| panic!("must not publish"),
            || None
        )
        .is_err());
        assert!(store.values.lock().unwrap().is_empty());
    }
    #[test]
    fn uncertain_activation_keeps_both_credentials_for_recovery() {
        let store = Store::default();
        let old = new_reference();
        store.write(&old, "original").unwrap();
        let mut config = VertebraeConfigFile::default();
        config.typesafe.api_key_secret = Some(old.clone());
        assert!(apply_and_persist(
            &mut config,
            edit(SecretEdit::Replace("new-key".into())),
            &store,
            |_| Err(invalid("Uncertain write")),
            || None
        )
        .is_err());
        assert_eq!(store.values.lock().unwrap().len(), 2);
        assert_eq!(store.read(&old).unwrap(), "original");
    }
    #[test]
    fn shared_references_are_retained_and_cleanup_errors_are_reported() {
        let store = Store::default();
        let old = new_reference();
        store.write(&old, "original").unwrap();
        let mut config = VertebraeConfigFile::default();
        config.typesafe.api_key_secret = Some(old.clone());
        let mut profile = vertebrae_core::ProviderProfile::new(vertebrae_core::StepHarness::Codex);
        profile.api_key_secret = Some(old.clone());
        config
            .providers
            .insert(ProviderId::new("shared").unwrap(), profile);
        apply_and_persist(
            &mut config,
            edit(SecretEdit::Clear),
            &store,
            |_| Ok(()),
            || None,
        )
        .unwrap();
        assert_eq!(store.read(&old).unwrap(), "original");
        let store = Store {
            fail_delete: true,
            ..store
        };
        config.typesafe.api_key_secret = Some(old.clone());
        config.providers.clear();
        let warning = apply_and_persist(
            &mut config,
            edit(SecretEdit::Clear),
            &store,
            |_| Ok(()),
            || None,
        )
        .unwrap();
        assert!(warning.is_some());
        assert!(config.typesafe.api_key_secret.is_none());
    }
}
