//! Provider identity and user-defined provider profiles.
//!
//! A provider names the endpoint/credential set a step or chat uses; the
//! [`StepHarness`] names the runtime adapter that talks to it. The built-in
//! providers (`anthropic`, `openai`, `typesafe`) need no configuration and map
//! 1:1 onto the `claude`, `codex`, and `typesafe` harnesses. Custom providers
//! are declared per machine under `[providers.<id>]` in `config.toml` and bind
//! to exactly one harness through their [`ProviderProfile`].

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::StepHarness;
use crate::model_catalog::BuiltinProvider;

const MAX_PROVIDER_ID_LEN: usize = 64;

/// Opaque provider identifier carried on `AgentConfig.provider`.
///
/// Identifiers are lowercase ASCII (`[a-z0-9][a-z0-9_-]*`, at most 64
/// characters) so they can be embedded safely in harness launch settings such
/// as Codex `model_providers.<id>` config keys.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ProviderId(String);

impl ProviderId {
    pub fn anthropic() -> Self {
        BuiltinProvider::Anthropic.id()
    }

    pub fn openai() -> Self {
        BuiltinProvider::Openai.id()
    }

    pub fn typesafe() -> Self {
        BuiltinProvider::Typesafe.id()
    }

    pub fn new(input: impl AsRef<str>) -> Result<Self, String> {
        let normalized = input.as_ref().trim().to_ascii_lowercase();
        let valid_start = normalized
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        let valid_rest = normalized
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
        if !valid_start || !valid_rest || normalized.len() > MAX_PROVIDER_ID_LEN {
            return Err(format!(
                "Invalid provider ID '{}'. Provider IDs use lowercase letters, digits, '-' and '_' (at most {} characters)",
                input.as_ref().trim(),
                MAX_PROVIDER_ID_LEN
            ));
        }
        Ok(Self(normalized))
    }

    /// Parse user input, accepting the built-in provider aliases
    /// (`claude`, `codex`, `system-one`, ...) before validating a custom ID.
    pub fn parse(input: &str) -> Result<Self, String> {
        match BuiltinProvider::parse_alias(input) {
            Some(builtin) => Ok(builtin.id()),
            None => Self::new(input),
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn builtin(&self) -> Option<BuiltinProvider> {
        BuiltinProvider::from_id(&self.0)
    }

    pub fn is_builtin(&self) -> bool {
        self.builtin().is_some()
    }
}

impl TryFrom<String> for ProviderId {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<ProviderId> for String {
    fn from(value: ProviderId) -> Self {
        value.0
    }
}

impl From<BuiltinProvider> for ProviderId {
    fn from(value: BuiltinProvider) -> Self {
        value.id()
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderWireApi {
    Chat,
    Responses,
}

impl ProviderWireApi {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Responses => "responses",
        }
    }
}

/// A user-defined provider declared under `[providers.<id>]` in config.toml.
///
/// The profile is provider-neutral data; each harness adapter translates it
/// into its own launch settings. Secrets (`api_key`, `env` values, TypeSafe
/// `url`) are always redacted from the Debug representation.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderProfile {
    pub harness: StepHarness,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Full System One endpoint URL for TypeSafe providers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    /// Literal API credential, used when `api_key_env` is unset or blank.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    /// Model used when a step or chat does not pick one; defaults to the
    /// first entry of `models`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wire_api: Option<ProviderWireApi>,
}

impl fmt::Debug for ProviderProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let env: BTreeMap<&str, &str> = self
            .env
            .keys()
            .map(|key| (key.as_str(), "<redacted>"))
            .collect();
        f.debug_struct("ProviderProfile")
            .field("harness", &self.harness)
            .field("base_url", &self.base_url.as_deref().map(redacted_base_url))
            .field("url", &self.url.as_ref().map(|_| "<redacted>"))
            .field("api_key_env", &self.api_key_env)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("env", &env)
            .field("models", &self.models)
            .field("default_model", &self.default_model)
            .field("wire_api", &self.wire_api)
            .finish()
    }
}

fn redacted_base_url(value: &str) -> &str {
    if value.contains('@') || value.contains('?') || value.contains('#') {
        "<redacted>"
    } else {
        value
    }
}

impl ProviderProfile {
    pub fn new(harness: StepHarness) -> Self {
        Self {
            harness,
            base_url: None,
            url: None,
            api_key_env: None,
            api_key: None,
            env: BTreeMap::new(),
            models: Vec::new(),
            default_model: None,
            wire_api: None,
        }
    }

    pub fn validate(&self, id: &ProviderId) -> Result<(), String> {
        if let Some(builtin) = BuiltinProvider::parse_alias(id.as_str()) {
            return Err(format!(
                "provider ID '{id}' is reserved for the built-in {builtin} provider; choose another ID for [providers.{id}]"
            ));
        }
        let invalid = |message: String| Err(format!("provider '{id}': {message}"));
        if self.models.iter().any(|model| model.trim().is_empty()) {
            return invalid("models must not contain blank entries".into());
        }
        if self.models.is_empty() {
            return invalid("models must list at least one model".into());
        }
        if let Some(default_model) = &self.default_model
            && !self.models.iter().any(|model| model == default_model)
        {
            return invalid(format!(
                "default_model '{default_model}' is not listed in models"
            ));
        }
        if self
            .api_key_env
            .as_deref()
            .is_some_and(|name| name.trim().is_empty())
        {
            return invalid("api_key_env must not be blank".into());
        }
        if self.env.keys().any(|key| key.trim().is_empty()) {
            return invalid("env keys must not be blank".into());
        }
        match self.harness {
            StepHarness::Claude | StepHarness::Codex => {
                if self.url.is_some() {
                    return invalid(format!(
                        "url is only supported for the typesafe harness; use base_url for the {} harness",
                        self.harness
                    ));
                }
                if self.harness == StepHarness::Claude && self.wire_api.is_some() {
                    return invalid("wire_api is only supported for the codex harness".into());
                }
            }
            StepHarness::Typesafe => {
                if self.base_url.is_some() {
                    return invalid(
                        "base_url is not supported for the typesafe harness; use url".into(),
                    );
                }
                if !self.env.is_empty() {
                    return invalid("env is not supported for the typesafe harness".into());
                }
                if self.wire_api.is_some() {
                    return invalid("wire_api is only supported for the codex harness".into());
                }
            }
        }
        Ok(())
    }

    /// Resolve the model to run: a requested model must be listed in
    /// `models`; otherwise `default_model`, then the first listed model.
    pub fn resolve_model(
        &self,
        id: &ProviderId,
        requested: Option<&str>,
    ) -> Result<String, String> {
        match requested.map(str::trim).filter(|model| !model.is_empty()) {
            Some(model) if self.models.iter().any(|listed| listed == model) => Ok(model.into()),
            Some(model) => Err(format!(
                "model '{model}' is not configured for provider '{id}'; configured models: {}",
                self.models.join(", ")
            )),
            None => self
                .default_model
                .clone()
                .or_else(|| self.models.first().cloned())
                .ok_or_else(|| format!("provider '{id}' has no models configured")),
        }
    }

    /// Resolve the API credential. A nonblank value of the `api_key_env`
    /// variable takes precedence over the literal `api_key`.
    pub fn resolve_api_key(&self, lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
        let nonblank = |value: String| (!value.trim().is_empty()).then_some(value);
        self.api_key_env
            .as_deref()
            .and_then(|name| lookup(name.trim()))
            .and_then(nonblank)
            .or_else(|| self.api_key.clone().and_then(nonblank))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(harness: StepHarness) -> ProviderProfile {
        ProviderProfile {
            models: vec!["model-a".into(), "model-b".into()],
            ..ProviderProfile::new(harness)
        }
    }

    #[test]
    fn provider_id_normalizes_and_rejects_unsafe_identifiers() {
        assert_eq!(
            ProviderId::new(" OpenRouter ").unwrap().as_str(),
            "openrouter"
        );
        assert_eq!(
            ProviderId::new("local_llm-2").unwrap().as_str(),
            "local_llm-2"
        );
        for invalid in [
            "",
            " ",
            "-lead",
            "has.dot",
            "has space",
            "slash/id",
            "ünicode",
        ] {
            assert!(
                ProviderId::new(invalid).is_err(),
                "{invalid:?} must be rejected"
            );
        }
        assert!(ProviderId::new("a".repeat(65)).is_err());
    }

    #[test]
    fn provider_id_parse_maps_builtin_aliases() {
        assert_eq!(
            ProviderId::parse("claude").unwrap(),
            ProviderId::anthropic()
        );
        assert_eq!(ProviderId::parse("Codex").unwrap(), ProviderId::openai());
        assert_eq!(
            ProviderId::parse("system_one").unwrap(),
            ProviderId::typesafe()
        );
        assert_eq!(
            ProviderId::parse("openrouter").unwrap().as_str(),
            "openrouter"
        );
        assert!(ProviderId::parse("open router").is_err());
    }

    #[test]
    fn provider_id_serializes_as_plain_string_and_validates_on_deserialize() {
        let id = ProviderId::new("openrouter").unwrap();
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"openrouter\"");
        let parsed: ProviderId = serde_json::from_str("\"anthropic\"").unwrap();
        assert_eq!(parsed.builtin(), Some(BuiltinProvider::Anthropic));
        assert!(serde_json::from_str::<ProviderId>("\"bad id\"").is_err());
    }

    #[test]
    fn profile_validation_enforces_harness_specific_fields() {
        let id = ProviderId::new("custom").unwrap();
        assert!(profile(StepHarness::Claude).validate(&id).is_ok());

        let error = profile(StepHarness::Claude)
            .validate(&ProviderId::anthropic())
            .unwrap_err();
        assert!(error.contains("reserved"), "{error}");
        let error = profile(StepHarness::Claude)
            .validate(&ProviderId::new("claude").unwrap())
            .unwrap_err();
        assert!(error.contains("reserved"), "{error}");

        let error = ProviderProfile::new(StepHarness::Codex)
            .validate(&id)
            .unwrap_err();
        assert!(error.contains("at least one model"), "{error}");

        let mut claude = profile(StepHarness::Claude);
        claude.wire_api = Some(ProviderWireApi::Chat);
        assert!(claude.validate(&id).unwrap_err().contains("wire_api"));

        let mut codex = profile(StepHarness::Codex);
        codex.url = Some("https://example.test".into());
        assert!(codex.validate(&id).unwrap_err().contains("base_url"));

        let mut typesafe = profile(StepHarness::Typesafe);
        typesafe.base_url = Some("https://example.test".into());
        assert!(typesafe.validate(&id).unwrap_err().contains("use url"));

        let mut default_missing = profile(StepHarness::Codex);
        default_missing.default_model = Some("model-z".into());
        assert!(
            default_missing
                .validate(&id)
                .unwrap_err()
                .contains("model-z")
        );
    }

    #[test]
    fn profile_resolves_models_only_from_its_list() {
        let id = ProviderId::new("custom").unwrap();
        let mut profile = profile(StepHarness::Codex);
        assert_eq!(profile.resolve_model(&id, None).unwrap(), "model-a");
        profile.default_model = Some("model-b".into());
        assert_eq!(profile.resolve_model(&id, Some(" ")).unwrap(), "model-b");
        assert_eq!(
            profile.resolve_model(&id, Some("model-a")).unwrap(),
            "model-a"
        );
        let error = profile.resolve_model(&id, Some("gpt-5.5")).unwrap_err();
        assert!(
            error.contains("gpt-5.5") && error.contains("custom"),
            "{error}"
        );
    }

    #[test]
    fn profile_prefers_environment_credential_and_redacts_debug() {
        let profile = ProviderProfile {
            api_key_env: Some("CUSTOM_KEY".into()),
            api_key: Some("literal-secret".into()),
            url: Some("https://user:url-secret@example.test".into()),
            env: BTreeMap::from([("EXTRA_TOKEN".into(), "env-secret".into())]),
            ..profile(StepHarness::Typesafe)
        };
        assert_eq!(
            profile.resolve_api_key(|name| (name == "CUSTOM_KEY").then(|| "env-key".into())),
            Some("env-key".into())
        );
        assert_eq!(
            profile.resolve_api_key(|_| Some("  ".into())),
            Some("literal-secret".into())
        );
        let debug = format!("{profile:?}");
        for secret in ["literal-secret", "url-secret", "env-secret"] {
            assert!(!debug.contains(secret), "{debug}");
        }
        assert!(debug.contains("CUSTOM_KEY") && debug.contains("EXTRA_TOKEN"));
    }
}
