//! Form-oriented, redacted access to this machine's shared configuration.
use serde::{Deserialize, Serialize};
use vertebrae_core::{ProviderId, ProviderProfile, StepHarness};
use vertebrae_sacrum_client::{config::ObservabilityConfig, VertebraeConfigFile};

#[path = "settings_credentials.rs"]
mod credentials;

use super::{validate_sacrum_token, validate_sacrum_url, CommandError};

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "action", content = "value", rename_all = "snake_case")]
pub enum SecretEdit {
    Keep,
    Replace(String),
    Clear,
    Migrate,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct EnvironmentEdit {
    pub name: String,
    pub secret: SecretEdit,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct ProviderSettings {
    pub id: String,
    pub harness: String,
    pub endpoint: String,
    pub endpoint_hidden: bool,
    pub models: Vec<String>,
    pub default_model: String,
    pub api_key_env: String,
    pub has_api_key: bool,
    pub key_storage: String,
    pub credential_override: bool,
    pub environment_names: Vec<String>,
    pub wire_api: String,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct ObservabilitySettings {
    pub enabled: bool,
    pub endpoint: String,
    pub protocol: String,
    pub signals: Vec<String>,
    pub subsystems: Vec<String>,
    pub level: String,
    pub capture_message_content: bool,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct SharedSettings {
    pub revision: String,
    pub path: String,
    pub connection_url: String,
    pub has_connection_token: bool,
    pub effective_connection_url: String,
    pub connection_url_override: bool,
    pub connection_token_override: bool,
    pub typesafe_url: String,
    pub typesafe_endpoint_hidden: bool,
    pub has_typesafe_key: bool,
    pub typesafe_key_storage: String,
    pub credential_warning: Option<String>,
    pub typesafe_key_override: bool,
    pub typesafe_url_override: bool,
    pub providers: Vec<ProviderSettings>,
    pub observability: ObservabilitySettings,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "section", rename_all = "snake_case")]
pub enum SettingsEdit {
    Connection {
        url: String,
        token: SecretEdit,
    },
    Typesafe {
        url: String,
        key: SecretEdit,
    },
    Provider {
        id: String,
        /// True only when creating a provider; prevents accidental replacement.
        create: bool,
        harness: String,
        endpoint: String,
        models: Vec<String>,
        default_model: String,
        api_key_env: String,
        key: SecretEdit,
        environment: Vec<EnvironmentEdit>,
        wire_api: String,
    },
    Observability {
        settings: ObservabilitySettings,
    },
}

fn invalid(message: &str) -> CommandError {
    CommandError {
        message: message.into(),
    }
}
fn nonblank(value: String) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.trim().to_owned())
}
fn env_present(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .is_some_and(|v| !v.trim().is_empty())
}
fn edit_secret(target: &mut Option<String>, edit: SecretEdit) -> Result<(), CommandError> {
    match edit {
        SecretEdit::Keep => (),
        SecretEdit::Clear => *target = None,
        SecretEdit::Migrate => {
            return Err(invalid(
                "Only provider API keys can be moved to the OS credential store.",
            ))
        }
        SecretEdit::Replace(value) => {
            let value = nonblank(value)
                .ok_or_else(|| invalid("Enter a nonblank replacement credential."))?;
            validate_sacrum_token(&value)?;
            *target = Some(value);
        }
    }
    Ok(())
}
fn safe_endpoint(value: &str) -> String {
    match url::Url::parse(value) {
        Ok(url)
            if url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none() =>
        {
            value.into()
        }
        _ => String::new(),
    }
}
fn endpoint(value: &str) -> Result<(), CommandError> {
    validate_sacrum_url(value)?;
    let parsed = url::Url::parse(value).map_err(|_| invalid("Enter a valid endpoint."))?;
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(invalid(
            "Endpoints must not contain query parameters or fragments.",
        ));
    }
    Ok(())
}
fn key_storage(literal: Option<&str>, reference: Option<&str>) -> &'static str {
    if reference.is_some() {
        "os"
    } else if literal.is_some() {
        "config"
    } else {
        "none"
    }
}

fn snapshot(config: &VertebraeConfigFile) -> Result<SharedSettings, CommandError> {
    let obs = serde_json::to_value(&config.observability)
        .map_err(|_| invalid("Could not read observability settings."))?;
    Ok(SharedSettings {
        revision: config.source_revision.clone().unwrap_or_default(),
        path: vertebrae_sacrum_client::config_path()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        connection_url: safe_endpoint(&config.sacrum.url),
        has_connection_token: config.sacrum.token.as_ref().is_some_and(|v| !v.is_empty()),
        effective_connection_url: safe_endpoint(
            &std::env::var("VTB_URL")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| config.sacrum.url.clone()),
        ),
        connection_url_override: env_present("VTB_URL"),
        connection_token_override: env_present("VTB_TOKEN"),
        typesafe_url: config
            .typesafe
            .url
            .as_deref()
            .map(safe_endpoint)
            .unwrap_or_default(),
        typesafe_endpoint_hidden: config
            .typesafe
            .url
            .as_deref()
            .is_some_and(|v| !v.is_empty() && safe_endpoint(v).is_empty()),
        has_typesafe_key: config.typesafe.api_key.is_some()
            || config.typesafe.api_key_secret.is_some(),
        typesafe_key_storage: key_storage(
            config.typesafe.api_key.as_deref(),
            config.typesafe.api_key_secret.as_deref(),
        )
        .into(),
        credential_warning: None,
        typesafe_key_override: env_present("TYPESAFE_API_KEY"),
        typesafe_url_override: env_present("TYPESAFE_BASE_URL"),
        providers: config
            .providers
            .iter()
            .map(|(id, p)| ProviderSettings {
                id: id.to_string(),
                harness: p.harness.to_string(),
                endpoint: p
                    .url
                    .as_deref()
                    .or(p.base_url.as_deref())
                    .map(safe_endpoint)
                    .unwrap_or_default(),
                endpoint_hidden: p
                    .url
                    .as_deref()
                    .or(p.base_url.as_deref())
                    .is_some_and(|v| !v.is_empty() && safe_endpoint(v).is_empty()),
                models: p.models.clone(),
                default_model: p.default_model.clone().unwrap_or_default(),
                api_key_env: p.api_key_env.clone().unwrap_or_default(),
                has_api_key: p.api_key.is_some() || p.api_key_secret.is_some(),
                key_storage: key_storage(p.api_key.as_deref(), p.api_key_secret.as_deref()).into(),
                credential_override: p
                    .api_key_env
                    .as_deref()
                    .is_some_and(|name| env_present(name.trim())),
                environment_names: p.env.keys().cloned().collect(),
                wire_api: p
                    .wire_api
                    .map(|v| {
                        match v {
                            vertebrae_core::ProviderWireApi::Chat => "chat",
                            vertebrae_core::ProviderWireApi::Responses => "responses",
                        }
                        .to_owned()
                    })
                    .unwrap_or_default(),
            })
            .collect(),
        observability: serde_json::from_value(obs)
            .map_err(|_| invalid("Could not read observability settings."))?,
    })
}

fn apply(config: &mut VertebraeConfigFile, edit: SettingsEdit) -> Result<(), CommandError> {
    match edit {
        SettingsEdit::Connection { url, token } => {
            endpoint(url.trim())?;
            edit_secret(&mut config.sacrum.token, token)?;
            if config.sacrum.token.is_none() && !env_present("VTB_TOKEN") {
                return Err(invalid(
                    "A backend token is required. Keep or replace the existing token.",
                ));
            }
            config.sacrum.url = url.trim().into();
        }
        SettingsEdit::Typesafe { url, key } => {
            if url.trim().is_empty()
                && config
                    .typesafe
                    .url
                    .as_deref()
                    .is_some_and(|v| !v.is_empty() && safe_endpoint(v).is_empty())
            {
                return Err(invalid("The stored endpoint contains sensitive URL components. Enter a safe replacement endpoint before saving."));
            }
            if !url.trim().is_empty() {
                endpoint(url.trim())?;
            }
            config.typesafe.url = nonblank(url);
            if !matches!(key, SecretEdit::Migrate) {
                edit_secret(&mut config.typesafe.api_key, key)?;
            }
        }
        SettingsEdit::Provider {
            id,
            create,
            harness,
            endpoint: provider_endpoint,
            models,
            default_model,
            api_key_env,
            key,
            environment,
            wire_api,
        } => {
            let id = ProviderId::new(&id).map_err(|_| {
                invalid("Provider ID must use lowercase letters, digits, hyphens or underscores.")
            })?;
            if id.is_builtin() {
                return Err(invalid(
                    "Choose a custom provider ID; built-in names are reserved.",
                ));
            }
            if create == config.providers.contains_key(&id) {
                return Err(invalid(if create {
                    "A provider with this ID already exists."
                } else {
                    "This provider no longer exists. Reload settings."
                }));
            }
            let harness: StepHarness = serde_json::from_value(serde_json::Value::String(harness))
                .map_err(|_| invalid("Select a supported harness."))?;
            if harness == StepHarness::MistralVibe {
                return Err(invalid(
                    "Custom Mistral Vibe profiles are not supported by this form.",
                ));
            }
            let mut provider = config
                .providers
                .get(&id)
                .cloned()
                .unwrap_or_else(|| ProviderProfile::new(harness));
            if provider_endpoint.trim().is_empty()
                && provider
                    .url
                    .as_deref()
                    .or(provider.base_url.as_deref())
                    .is_some_and(|v| !v.is_empty() && safe_endpoint(v).is_empty())
            {
                return Err(invalid("The stored endpoint contains sensitive URL components. Enter a safe replacement endpoint before saving."));
            }
            provider.harness = harness;
            if !provider_endpoint.trim().is_empty() {
                endpoint(provider_endpoint.trim())?;
            }
            provider.url = None;
            provider.base_url = None;
            if harness == StepHarness::Typesafe {
                provider.url = nonblank(provider_endpoint);
            } else {
                provider.base_url = nonblank(provider_endpoint);
            }
            provider.models = models.into_iter().map(|v| v.trim().to_owned()).collect();
            if provider
                .models
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != provider.models.len()
            {
                return Err(invalid("Model IDs must be unique."));
            }
            provider.default_model = nonblank(default_model);
            provider.api_key_env = nonblank(api_key_env);
            if !matches!(key, SecretEdit::Migrate) {
                edit_secret(&mut provider.api_key, key)?;
            }
            provider.wire_api = match wire_api.as_str() {
                "" => None,
                "chat" => Some(vertebrae_core::ProviderWireApi::Chat),
                "responses" => Some(vertebrae_core::ProviderWireApi::Responses),
                _ => return Err(invalid("Select Chat or Responses wire API.")),
            };
            for entry in environment {
                if entry.name.trim().is_empty()
                    || entry.name.contains('=')
                    || entry.name.contains('\0')
                {
                    return Err(invalid("Enter a valid environment variable name."));
                }
                let mut value = provider.env.get(&entry.name).cloned();
                edit_secret(&mut value, entry.secret)?;
                if let Some(value) = value {
                    provider.env.insert(entry.name, value);
                } else {
                    provider.env.remove(&entry.name);
                }
            }
            provider.validate(&id).map_err(|_| {
                invalid("Check the model list, default model and harness-specific options.")
            })?;
            config.providers.insert(id, provider);
        }
        SettingsEdit::Observability { settings } => {
            endpoint(settings.endpoint.trim())?;
            config.observability = serde_json::from_value::<ObservabilityConfig>(
                serde_json::to_value(settings)
                    .map_err(|_| invalid("Invalid observability settings."))?,
            )
            .map_err(|_| {
                invalid("Select supported telemetry protocol, signals, subsystems and level.")
            })?;
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_shared_settings() -> Result<SharedSettings, CommandError> {
    tokio::task::spawn_blocking(|| {
        let config = vertebrae_sacrum_client::load_config_file().map_err(|_| {
            invalid("Could not read config.toml. Check its syntax and permissions, then reload.")
        })?;
        snapshot(&config)
    })
    .await
    .map_err(|_| invalid("Settings read failed."))?
}

#[tauri::command]
#[specta::specta]
pub async fn save_shared_settings(
    revision: String,
    edit: SettingsEdit,
) -> Result<SharedSettings, CommandError> {
    tokio::task::spawn_blocking(move || {
        let mut config = vertebrae_sacrum_client::load_config_file().map_err(|_| invalid("Could not read config.toml. Check its syntax and permissions, then reload."))?;
        if config.source_revision.as_deref() != Some(&revision) { return Err(invalid("Configuration changed on disk. Reload and reapply your edits.")); }
        let warning = credentials::apply_and_persist(&mut config, edit, &vertebrae_credentials::OsSecretStore,
            |config| vertebrae_sacrum_client::save_config_file(config).map_err(|_| invalid("Could not save settings. The file may have changed or be unwritable. Reload before retrying.")),
            || vertebrae_sacrum_client::load_config_file().ok(),
        )?;
        let config = vertebrae_sacrum_client::load_config_file().map_err(|_| invalid("Settings were saved, but could not be reread. Reload settings."))?;
        let mut settings = snapshot(&config)?;
        settings.credential_warning = warning;
        Ok(settings)
    }).await.map_err(|_| invalid("Settings save failed."))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_never_expose_credentials_or_environment_values() {
        let mut config = VertebraeConfigFile::default();
        config.sacrum.token = Some("backend-secret".into());
        config.typesafe.api_key = Some("typesafe-secret".into());
        config.typesafe.api_key_secret = Some("typesafe-reference-not-for-the-frontend".into());
        config.typesafe.url = Some("https://api.example/?token=url-secret".into());
        let mut profile = ProviderProfile::new(StepHarness::Codex);
        profile.api_key = Some("provider-secret".into());
        profile.api_key_secret = Some("provider-reference-not-for-the-frontend".into());
        profile
            .env
            .insert("KEY".into(), "environment-secret".into());
        profile.models = vec!["model".into()];
        config
            .providers
            .insert(ProviderId::new("custom").unwrap(), profile);
        let text = serde_json::to_string(&snapshot(&config).unwrap()).unwrap();
        for secret in [
            "backend-secret",
            "typesafe-secret",
            "url-secret",
            "provider-secret",
            "environment-secret",
            "typesafe-reference-not-for-the-frontend",
            "provider-reference-not-for-the-frontend",
        ] {
            assert!(!text.contains(secret));
        }
        assert!(text.contains("KEY"));
    }

    #[test]
    fn hidden_endpoint_requires_explicit_replacement() {
        let mut config = VertebraeConfigFile::default();
        config.typesafe.url = Some("https://api.example/?token=secret".into());
        assert!(snapshot(&config).unwrap().typesafe_endpoint_hidden);
        assert!(apply(
            &mut config,
            SettingsEdit::Typesafe {
                url: String::new(),
                key: SecretEdit::Keep
            }
        )
        .is_err());
        assert_eq!(
            config.typesafe.url.as_deref(),
            Some("https://api.example/?token=secret")
        );
    }

    #[test]
    fn secret_edits_are_explicit_and_reject_blank_or_header_invalid_values() {
        let mut value = Some("existing".into());
        edit_secret(&mut value, SecretEdit::Keep).unwrap();
        assert_eq!(value.as_deref(), Some("existing"));
        edit_secret(&mut value, SecretEdit::Replace("replacement".into())).unwrap();
        assert_eq!(value.as_deref(), Some("replacement"));
        assert!(edit_secret(&mut value, SecretEdit::Replace(" \n".into())).is_err());
        assert!(edit_secret(&mut value, SecretEdit::Replace("bad\nvalue".into())).is_err());
        edit_secret(&mut value, SecretEdit::Clear).unwrap();
        assert!(value.is_none());
    }

    fn provider_edit(
        id: &str,
        harness: &str,
        models: Vec<String>,
        default_model: &str,
    ) -> SettingsEdit {
        SettingsEdit::Provider {
            id: id.into(),
            create: true,
            harness: harness.into(),
            endpoint: "http://localhost:8000".into(),
            models,
            default_model: default_model.into(),
            api_key_env: String::new(),
            key: SecretEdit::Keep,
            environment: Vec::new(),
            wire_api: String::new(),
        }
    }

    #[test]
    fn validates_provider_identity_harness_and_model_contracts() {
        let mut config = VertebraeConfigFile::default();
        assert!(apply(
            &mut config,
            provider_edit("openai", "codex", vec!["m".into()], "")
        )
        .is_err());
        assert!(apply(
            &mut config,
            provider_edit("custom", "unknown", vec!["m".into()], "")
        )
        .is_err());
        assert!(apply(&mut config, provider_edit("custom", "codex", vec![], "")).is_err());
        assert!(apply(
            &mut config,
            provider_edit("custom", "codex", vec!["m".into()], "other")
        )
        .is_err());
        apply(
            &mut config,
            provider_edit("custom", "codex", vec!["m".into()], "m"),
        )
        .unwrap();
        assert!(apply(
            &mut config,
            provider_edit("custom", "codex", vec!["m".into()], "m")
        )
        .is_err());
    }

    #[test]
    fn connection_edit_preserves_projects_and_replaces_only_requested_secret() {
        let mut config = VertebraeConfigFile::default();
        config.projects.insert(
            "existing".into(),
            vertebrae_sacrum_client::ProjectSection {
                id: "project-id".into(),
                path: "/code/project".into(),
            },
        );
        config.typesafe.api_key = Some("keep-me".into());
        apply(
            &mut config,
            SettingsEdit::Connection {
                url: "https://backend.example".into(),
                token: SecretEdit::Replace("new-token".into()),
            },
        )
        .unwrap();
        assert_eq!(config.sacrum.token.as_deref(), Some("new-token"));
        assert_eq!(config.typesafe.api_key.as_deref(), Some("keep-me"));
        assert_eq!(config.projects["existing"].path, "/code/project");
        assert!(endpoint("https://user:password@example.com").is_err());
        assert!(endpoint("https://example.com?token=secret").is_err());
    }
}
