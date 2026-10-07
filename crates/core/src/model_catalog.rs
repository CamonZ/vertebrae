//! Model catalog: maps model names to their built-in execution provider.
//!
//! This is a small, conservative classifier used by Vertebrae to validate
//! `--model` / `--provider` combinations for the built-in providers. It is
//! intentionally not an exhaustive list of every model name a vendor
//! publishes -- vendor catalogs change frequently. We only recognize the
//! aliases and prefixes Vertebrae intentionally supports today, and we reject
//! everything else with a clear error so users update the catalog before
//! depending on a new model name. Custom providers declared in config.toml are
//! validated only against their own `models` list, never against these rules.
//!
//! Built-in providers:
//! - `anthropic` (Claude Code): `claude-*` prefix and the bare aliases
//!   `opus`, `sonnet`, `haiku`, `fable`.
//! - `openai` (Codex / GPT): `gpt-*` prefix, `o*` reasoning models
//!   (e.g. `o1`, `o3`, `o4-mini`), and `codex-*`.
//! - `typesafe` (TypeSafe System One): `jev-*` models, including the
//!   documented `jev-latest` default.
//!
//! Request capability rules (reasoning effort, personality, verbosity, and
//! agent-only options) depend on the harness that consumes them, so they key
//! on [`StepHarness`] and apply equally to built-in and custom providers.

use crate::{AgentConfig, OutputVerbosity, ProviderId, StepHarness};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Codex reasoning efforts currently accepted by the Codex harness.
pub const SUPPORTED_OPENAI_REASONING_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh"];

pub const DEFAULT_TYPESAFE_MODEL: &str = "jev-latest";

/// Built-in execution providers recognized by Vertebrae without any
/// configuration. Each one runs on exactly one harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinProvider {
    Anthropic,
    Openai,
    Typesafe,
}

impl BuiltinProvider {
    pub const ALL: [BuiltinProvider; 3] = [Self::Anthropic, Self::Openai, Self::Typesafe];

    /// String form used on the CLI and in serialized agent_config JSON.
    pub const fn as_str(self) -> &'static str {
        match self {
            BuiltinProvider::Anthropic => "anthropic",
            BuiltinProvider::Openai => "openai",
            BuiltinProvider::Typesafe => "typesafe",
        }
    }

    pub fn id(self) -> ProviderId {
        ProviderId::new(self.as_str()).expect("built-in provider IDs are valid")
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|builtin| builtin.as_str() == id)
    }

    /// Case-insensitive lookup accepting canonical names plus common aliases.
    pub fn parse_alias(input: &str) -> Option<Self> {
        match input.trim().to_ascii_lowercase().as_str() {
            "anthropic" | "claude" => Some(BuiltinProvider::Anthropic),
            "openai" | "codex" => Some(BuiltinProvider::Openai),
            "typesafe" | "type-safe" | "type_safe" | "systemone" | "system-one" | "system_one" => {
                Some(BuiltinProvider::Typesafe)
            }
            _ => None,
        }
    }

    pub const fn harness(self) -> StepHarness {
        match self {
            BuiltinProvider::Anthropic => StepHarness::Claude,
            BuiltinProvider::Openai => StepHarness::Codex,
            BuiltinProvider::Typesafe => StepHarness::Typesafe,
        }
    }

    pub const fn for_harness(harness: StepHarness) -> Self {
        match harness {
            StepHarness::Claude => BuiltinProvider::Anthropic,
            StepHarness::Codex => BuiltinProvider::Openai,
            StepHarness::Typesafe => BuiltinProvider::Typesafe,
        }
    }

    pub const fn default_model(self) -> Option<&'static str> {
        match self {
            BuiltinProvider::Typesafe => Some(DEFAULT_TYPESAFE_MODEL),
            BuiltinProvider::Anthropic | BuiltinProvider::Openai => None,
        }
    }
}

impl fmt::Display for BuiltinProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Classify a model name to its built-in provider.
///
/// Returns `Some(provider)` when the name matches one of the conservative
/// aliases/prefixes we recognize, and `None` for anything else. Unknown
/// names are not silently mapped to a provider -- callers should reject
/// them or require an explicit override.
pub fn classify_model(model: &str) -> Option<BuiltinProvider> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.to_ascii_lowercase();

    // Anthropic: bare aliases and `claude-*` prefix.
    if matches!(normalized.as_str(), "opus" | "sonnet" | "haiku" | "fable")
        || normalized.starts_with("claude-")
        || normalized == "claude"
    {
        return Some(BuiltinProvider::Anthropic);
    }

    // OpenAI: `gpt-*`, `codex-*`, and reasoning `o<digit>...` models
    // (o1, o1-mini, o3, o3-mini, o4-mini, ...). We require the `o` to be
    // followed by a digit so we don't accidentally swallow names like
    // `opus`.
    if normalized.starts_with("gpt-")
        || normalized == "gpt"
        || normalized.starts_with("codex-")
        || normalized == "codex"
        || is_openai_reasoning_alias(&normalized)
    {
        return Some(BuiltinProvider::Openai);
    }

    // TypeSafe System One: keep the catalog intentionally narrow while
    // accepting future documented JEV model revisions.
    if normalized == "jev" || normalized.starts_with("jev-") {
        return Some(BuiltinProvider::Typesafe);
    }

    None
}

/// Match `o1`, `o3`, `o4-mini`, `o1-pro`, etc. -- but not `opus` or `other`.
fn is_openai_reasoning_alias(normalized: &str) -> bool {
    let mut chars = normalized.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if first != 'o' {
        return false;
    }
    let Some(second) = chars.next() else {
        return false;
    };
    if !second.is_ascii_digit() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Validate that a built-in `(provider, model)` pair is internally consistent.
///
/// Rules:
/// - If the model is recognized and maps to a different provider, reject with
///   an actionable error.
/// - If the model is not recognized at all, reject with an error pointing to
///   catalog support.
/// - If the model is `None`, any provider is fine -- the provider can be
///   stored on the agent_config without a model.
pub fn validate_provider_model(
    provider: BuiltinProvider,
    model: Option<&str>,
) -> Result<(), ProviderModelMismatch> {
    validate_provider_model_with_codex_provider(provider, model, None)
}

/// Validate a built-in `(provider, model)` pair, allowing arbitrary Codex
/// upstream model IDs only when the built-in provider is OpenAI/Codex and an
/// explicit Codex model provider override is configured.
pub fn validate_provider_model_with_codex_provider(
    provider: BuiltinProvider,
    model: Option<&str>,
    codex_model_provider: Option<&str>,
) -> Result<(), ProviderModelMismatch> {
    if let Some(codex_model_provider) = codex_model_provider
        && !codex_model_provider.trim().is_empty()
    {
        if provider != BuiltinProvider::Openai {
            return Err(ProviderModelMismatch::UnsupportedCodexModelProvider {
                requested: provider,
                codex_model_provider: codex_model_provider.trim().to_string(),
            });
        }
        if let Some(model) = model
            && let Some(err) = wrong_provider_error(provider, model)
        {
            return Err(err);
        }
        return Ok(());
    }

    let Some(model) = model else {
        return Ok(());
    };
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    match classify_model(trimmed) {
        Some(detected) if detected == provider => Ok(()),
        Some(_) => Err(wrong_provider_error(provider, trimmed).expect("detected wrong provider")),
        None => Err(ProviderModelMismatch::UnknownModel {
            requested: provider,
            model: trimmed.to_string(),
        }),
    }
}

fn wrong_provider_error(provider: BuiltinProvider, model: &str) -> Option<ProviderModelMismatch> {
    let trimmed = model.trim();
    classify_model(trimmed).and_then(|detected| {
        (detected != provider).then(|| ProviderModelMismatch::WrongProvider {
            requested: provider,
            detected,
            model: trimmed.to_string(),
        })
    })
}

/// Validate that a reasoning effort is supported by the harness.
///
/// Reasoning effort is a Codex-only setting. Claude and TypeSafe steps reject
/// it before persistence or spawn so it never leaks into Claude argv.
pub fn normalize_harness_reasoning_effort(
    harness: StepHarness,
    reasoning_effort: Option<&str>,
) -> Result<Option<String>, ProviderReasoningEffortMismatch> {
    let Some(reasoning_effort) = reasoning_effort else {
        return Ok(None);
    };
    let normalized = reasoning_effort.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err(ProviderReasoningEffortMismatch::UnsupportedEffort {
            effort: reasoning_effort.to_string(),
        });
    }
    if harness != StepHarness::Codex {
        return Err(ProviderReasoningEffortMismatch::UnsupportedHarness {
            harness,
            effort: normalized,
        });
    }
    if SUPPORTED_OPENAI_REASONING_EFFORTS.contains(&normalized.as_str()) {
        return Ok(Some(normalized));
    }
    Err(ProviderReasoningEffortMismatch::UnsupportedEffort { effort: normalized })
}

pub fn validate_harness_reasoning_effort(
    harness: StepHarness,
    reasoning_effort: Option<&str>,
) -> Result<(), ProviderReasoningEffortMismatch> {
    normalize_harness_reasoning_effort(harness, reasoning_effort).map(|_| ())
}

/// Validate agent-only settings before a harness runtime is constructed.
/// TypeSafe accepts only its provider and model selection; chat-oriented agent
/// options must fail instead of being silently ignored by the one-shot adapter.
pub fn validate_harness_agent_config(
    harness: StepHarness,
    config: &AgentConfig,
) -> Result<(), ProviderAgentOptionMismatch> {
    if harness != StepHarness::Typesafe {
        return Ok(());
    }

    let unsupported = [
        (
            "codex_model_provider",
            config.codex_model_provider.is_some(),
        ),
        ("reasoning_effort", config.reasoning_effort.is_some()),
        ("speed_tier", config.speed_tier.is_some()),
        ("personality", config.personality.is_some()),
        ("verbosity", config.verbosity.is_some()),
        ("fallback_model", config.fallback_model.is_some()),
        ("system_prompt", config.system_prompt.is_some()),
        (
            "append_system_prompt",
            config.append_system_prompt.is_some(),
        ),
        ("agents", config.agents.is_some()),
        ("tools", !config.tools.is_empty()),
        ("allowed_tools", !config.allowed_tools.is_empty()),
        ("disallowed_tools", !config.disallowed_tools.is_empty()),
        ("permission_mode", config.permission_mode.is_some()),
        ("max_budget_usd", config.max_budget_usd.is_some()),
        ("mcp_config", !config.mcp_config.is_empty()),
        ("plugin_dirs", !config.plugin_dirs.is_empty()),
        ("json_schema", config.json_schema.is_some()),
    ];
    if let Some((option, true)) = unsupported.into_iter().find(|(_, present)| *present) {
        return Err(ProviderAgentOptionMismatch { harness, option });
    }
    Ok(())
}

/// Normalize the opaque provider style identifier carried by the shared
/// request contract.
pub fn normalize_personality(
    personality: Option<&str>,
) -> Result<Option<String>, ProviderPersonalityMismatch> {
    let Some(personality) = personality else {
        return Ok(None);
    };
    let normalized = personality.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err(ProviderPersonalityMismatch::Empty);
    }
    Ok(Some(normalized))
}

/// Normalize and validate a personality for a specific harness.
/// Claude output styles remain provider-defined strings; Codex's app-server
/// currently accepts the explicit `none`, `friendly`, and `pragmatic` enum.
pub fn normalize_harness_personality(
    harness: StepHarness,
    personality: Option<&str>,
) -> Result<Option<String>, ProviderPersonalityMismatch> {
    let personality = normalize_personality(personality)?;
    if harness == StepHarness::Typesafe && personality.is_some() {
        return Err(ProviderPersonalityMismatch::UnsupportedHarness { harness });
    }
    if harness == StepHarness::Codex
        && let Some(personality) = personality.as_deref()
        && !matches!(personality, "none" | "friendly" | "pragmatic")
    {
        return Err(ProviderPersonalityMismatch::UnsupportedValue {
            harness,
            personality: personality.to_string(),
        });
    }
    Ok(personality)
}

/// Validate output verbosity against the harness that will consume it.
/// Codex is the first harness with a native output-detail setting.
pub fn normalize_harness_verbosity(
    harness: StepHarness,
    verbosity: Option<OutputVerbosity>,
) -> Result<Option<OutputVerbosity>, ProviderVerbosityMismatch> {
    let Some(verbosity) = verbosity else {
        return Ok(None);
    };
    if harness == StepHarness::Codex {
        Ok(Some(verbosity))
    } else {
        Err(ProviderVerbosityMismatch::UnsupportedHarness { harness })
    }
}

/// Reasons a built-in `(provider, model)` pair can fail validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderModelMismatch {
    /// The model is recognized but belongs to a different provider.
    WrongProvider {
        requested: BuiltinProvider,
        detected: BuiltinProvider,
        model: String,
    },
    /// The model is not recognized by the built-in catalog at all.
    UnknownModel {
        requested: BuiltinProvider,
        model: String,
    },
    /// Codex upstream provider overrides are only valid on the Codex harness.
    UnsupportedCodexModelProvider {
        requested: BuiltinProvider,
        codex_model_provider: String,
    },
}

impl fmt::Display for ProviderModelMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProviderModelMismatch::WrongProvider {
                requested,
                detected,
                model,
            } => write!(
                f,
                "Model '{}' is an {} model and cannot be used with --provider {}. Pass --provider {} or pick a {} model.",
                model, detected, requested, detected, requested
            ),
            ProviderModelMismatch::UnknownModel { requested, model } => write!(
                f,
                "Model '{}' is not recognized by the built-in {} catalog. \
                 If this is a valid {} model, update the model catalog or declare a custom provider under [providers.<id>] in config.toml.",
                model, requested, requested
            ),
            ProviderModelMismatch::UnsupportedCodexModelProvider {
                requested,
                codex_model_provider,
            } => write!(
                f,
                "codex_model_provider '{}' is only valid with --provider openai / Codex. Current provider is {}.",
                codex_model_provider, requested
            ),
        }
    }
}

impl std::error::Error for ProviderModelMismatch {}

/// Reasons a harness/reasoning-effort pair can fail validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderReasoningEffortMismatch {
    /// The effort value is not in Codex's supported allowlist.
    UnsupportedEffort { effort: String },
    /// The effort is valid for Codex but was attached to another harness.
    UnsupportedHarness {
        harness: StepHarness,
        effort: String,
    },
}

/// Reasons a personality value can fail shared-contract validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderPersonalityMismatch {
    Empty,
    UnsupportedHarness {
        harness: StepHarness,
    },
    UnsupportedValue {
        harness: StepHarness,
        personality: String,
    },
}

impl fmt::Display for ProviderPersonalityMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("personality must not be empty"),
            Self::UnsupportedHarness { harness } => {
                write!(f, "personality is not supported by the {} harness", harness)
            }
            Self::UnsupportedValue {
                harness,
                personality,
            } => write!(
                f,
                "personality '{}' is not supported by the {} harness; supported Codex values are none, friendly, and pragmatic",
                personality, harness
            ),
        }
    }
}

impl std::error::Error for ProviderPersonalityMismatch {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAgentOptionMismatch {
    pub harness: StepHarness,
    pub option: &'static str,
}

impl fmt::Display for ProviderAgentOptionMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "AgentConfig.{} is not supported by the {} harness",
            self.option, self.harness
        )
    }
}

impl std::error::Error for ProviderAgentOptionMismatch {}

/// Reasons an output verbosity value can fail harness validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderVerbosityMismatch {
    UnsupportedHarness { harness: StepHarness },
}

impl fmt::Display for ProviderVerbosityMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedHarness { harness } => write!(
                f,
                "output verbosity is not supported by the {} harness",
                harness
            ),
        }
    }
}

impl std::error::Error for ProviderVerbosityMismatch {}

impl fmt::Display for ProviderReasoningEffortMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProviderReasoningEffortMismatch::UnsupportedEffort { effort } => write!(
                f,
                "Reasoning effort '{}' is not supported. Supported OpenAI/Codex reasoning efforts: {}.",
                effort,
                SUPPORTED_OPENAI_REASONING_EFFORTS.join(", ")
            ),
            ProviderReasoningEffortMismatch::UnsupportedHarness { harness, effort } => write!(
                f,
                "Reasoning effort '{}' is only supported on the codex harness (--provider openai or a codex custom provider). Current harness is {}.",
                effort, harness
            ),
        }
    }
}

impl std::error::Error for ProviderReasoningEffortMismatch {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_anthropic_aliases() {
        assert_eq!(classify_model("opus"), Some(BuiltinProvider::Anthropic));
        assert_eq!(classify_model("sonnet"), Some(BuiltinProvider::Anthropic));
        assert_eq!(classify_model("haiku"), Some(BuiltinProvider::Anthropic));
        assert_eq!(classify_model("fable"), Some(BuiltinProvider::Anthropic));
        assert_eq!(classify_model("Opus"), Some(BuiltinProvider::Anthropic));
    }

    #[test]
    fn classify_anthropic_prefixes() {
        assert_eq!(
            classify_model("claude-opus-4-5"),
            Some(BuiltinProvider::Anthropic)
        );
        assert_eq!(
            classify_model("claude-opus-5-5"),
            Some(BuiltinProvider::Anthropic)
        );
        assert_eq!(
            classify_model("claude-3-5-sonnet"),
            Some(BuiltinProvider::Anthropic)
        );
        assert_eq!(
            classify_model("claude-haiku-4-5"),
            Some(BuiltinProvider::Anthropic)
        );
        assert_eq!(
            classify_model("claude-haiku-5-5"),
            Some(BuiltinProvider::Anthropic)
        );
        assert_eq!(classify_model("claude"), Some(BuiltinProvider::Anthropic));
    }

    #[test]
    fn classify_openai_gpt() {
        assert_eq!(classify_model("gpt-4"), Some(BuiltinProvider::Openai));
        assert_eq!(classify_model("gpt-4o"), Some(BuiltinProvider::Openai));
        assert_eq!(classify_model("gpt-4o-mini"), Some(BuiltinProvider::Openai));
        assert_eq!(classify_model("GPT-5"), Some(BuiltinProvider::Openai));
    }

    #[test]
    fn classify_openai_reasoning() {
        assert_eq!(classify_model("o1"), Some(BuiltinProvider::Openai));
        assert_eq!(classify_model("o1-mini"), Some(BuiltinProvider::Openai));
        assert_eq!(classify_model("o3"), Some(BuiltinProvider::Openai));
        assert_eq!(classify_model("o3-mini"), Some(BuiltinProvider::Openai));
        assert_eq!(classify_model("o4-mini"), Some(BuiltinProvider::Openai));
    }

    #[test]
    fn classify_openai_codex() {
        assert_eq!(
            classify_model("codex-mini-latest"),
            Some(BuiltinProvider::Openai)
        );
        assert_eq!(classify_model("codex"), Some(BuiltinProvider::Openai));
    }

    #[test]
    fn classify_typesafe_models_and_default() {
        assert_eq!(
            classify_model(DEFAULT_TYPESAFE_MODEL),
            Some(BuiltinProvider::Typesafe)
        );
        assert_eq!(classify_model("jev"), Some(BuiltinProvider::Typesafe));
        assert_eq!(
            classify_model("JEV-preview"),
            Some(BuiltinProvider::Typesafe)
        );
        assert_eq!(
            BuiltinProvider::Typesafe.default_model(),
            Some(DEFAULT_TYPESAFE_MODEL)
        );
    }

    #[test]
    fn classify_unknown_returns_none() {
        assert_eq!(classify_model("kimi2.6"), None);
        assert_eq!(classify_model("llama-3"), None);
        assert_eq!(classify_model("mistral-large"), None);
        assert_eq!(classify_model(""), None);
        assert_eq!(classify_model("   "), None);
    }

    #[test]
    fn classify_does_not_confuse_opus_with_o_prefix() {
        // 'opus' starts with 'o' but is not o<digit>, so it must be Anthropic.
        assert_eq!(classify_model("opus"), Some(BuiltinProvider::Anthropic));
        // 'other' starts with 'o' but second char isn't a digit -> not openai.
        assert_eq!(classify_model("other-model"), None);
    }

    #[test]
    fn builtin_provider_parse_alias_accepts_canonical_names_and_aliases() {
        assert_eq!(
            BuiltinProvider::parse_alias("Anthropic"),
            Some(BuiltinProvider::Anthropic)
        );
        assert_eq!(
            BuiltinProvider::parse_alias("OPENAI"),
            Some(BuiltinProvider::Openai)
        );
        assert_eq!(
            BuiltinProvider::parse_alias("claude"),
            Some(BuiltinProvider::Anthropic)
        );
        assert_eq!(
            BuiltinProvider::parse_alias("codex"),
            Some(BuiltinProvider::Openai)
        );
        assert_eq!(
            BuiltinProvider::parse_alias("type-safe"),
            Some(BuiltinProvider::Typesafe)
        );
        assert_eq!(
            BuiltinProvider::parse_alias("system_one"),
            Some(BuiltinProvider::Typesafe)
        );
        assert_eq!(BuiltinProvider::parse_alias("bedrock"), None);
        assert_eq!(BuiltinProvider::from_id("claude"), None);
    }

    #[test]
    fn builtin_providers_map_one_to_one_onto_harnesses() {
        for builtin in BuiltinProvider::ALL {
            assert_eq!(BuiltinProvider::for_harness(builtin.harness()), builtin);
            assert_eq!(builtin.id().builtin(), Some(builtin));
        }
    }

    #[test]
    fn validate_accepts_matching_pair() {
        assert!(validate_provider_model(BuiltinProvider::Anthropic, Some("opus")).is_ok());
        assert!(
            validate_provider_model(BuiltinProvider::Anthropic, Some("claude-opus-4-5")).is_ok()
        );
        assert!(
            validate_provider_model(BuiltinProvider::Anthropic, Some("claude-opus-5-5")).is_ok()
        );
        assert!(validate_provider_model(BuiltinProvider::Anthropic, Some("fable")).is_ok());
        assert!(
            validate_provider_model(BuiltinProvider::Anthropic, Some("claude-haiku-5-5")).is_ok()
        );
        assert!(validate_provider_model(BuiltinProvider::Openai, Some("gpt-4o")).is_ok());
        assert!(validate_provider_model(BuiltinProvider::Openai, Some("o3-mini")).is_ok());
        assert!(
            validate_provider_model(BuiltinProvider::Typesafe, Some(DEFAULT_TYPESAFE_MODEL))
                .is_ok()
        );
    }

    #[test]
    fn validate_accepts_no_model() {
        assert!(validate_provider_model(BuiltinProvider::Openai, None).is_ok());
        assert!(validate_provider_model(BuiltinProvider::Anthropic, Some("")).is_ok());
    }

    #[test]
    fn validate_rejects_wrong_provider() {
        let err = validate_provider_model(BuiltinProvider::Openai, Some("claude-opus"))
            .expect_err("must err");
        match err {
            ProviderModelMismatch::WrongProvider {
                requested,
                detected,
                ref model,
            } => {
                assert_eq!(requested, BuiltinProvider::Openai);
                assert_eq!(detected, BuiltinProvider::Anthropic);
                assert_eq!(model, "claude-opus");
            }
            other => panic!("expected WrongProvider, got {:?}", other),
        }
        let msg = format!("{}", err);
        assert!(msg.contains("claude-opus"));
        assert!(msg.contains("anthropic"));
        assert!(msg.contains("openai"));
    }

    #[test]
    fn validate_rejects_unknown_model() {
        let err = validate_provider_model(BuiltinProvider::Openai, Some("kimi2.6"))
            .expect_err("must err");
        match err {
            ProviderModelMismatch::UnknownModel {
                requested,
                ref model,
            } => {
                assert_eq!(requested, BuiltinProvider::Openai);
                assert_eq!(model, "kimi2.6");
            }
            other => panic!("expected UnknownModel, got {:?}", other),
        }
        let msg = format!("{}", err);
        assert!(msg.contains("kimi2.6"));
        assert!(msg.contains("catalog"));
    }

    #[test]
    fn validate_accepts_openai_unknown_model_with_codex_provider_override() {
        assert!(
            validate_provider_model_with_codex_provider(
                BuiltinProvider::Openai,
                Some("deepseek/deepseek-v4-flash"),
                Some("openrouter"),
            )
            .is_ok()
        );
        assert!(
            validate_provider_model_with_codex_provider(
                BuiltinProvider::Openai,
                Some("glm-5.1"),
                Some("zai"),
            )
            .is_ok()
        );
    }

    #[test]
    fn validate_rejects_codex_provider_override_with_anthropic() {
        let err = validate_provider_model_with_codex_provider(
            BuiltinProvider::Anthropic,
            Some("claude-opus-4-5"),
            Some("openrouter"),
        )
        .expect_err("anthropic codex provider override must fail");
        assert!(matches!(
            err,
            ProviderModelMismatch::UnsupportedCodexModelProvider {
                requested: BuiltinProvider::Anthropic,
                ..
            }
        ));
        let msg = err.to_string();
        assert!(msg.contains("openrouter"));
        assert!(msg.contains("openai"));
        assert!(msg.contains("anthropic"));
    }

    #[test]
    fn validate_rejects_wrong_provider_even_with_codex_provider_override() {
        let err = validate_provider_model_with_codex_provider(
            BuiltinProvider::Openai,
            Some("claude-opus-4-5"),
            Some("openrouter"),
        )
        .expect_err("recognized Anthropic model must still fail");
        assert!(matches!(
            err,
            ProviderModelMismatch::WrongProvider {
                requested: BuiltinProvider::Openai,
                detected: BuiltinProvider::Anthropic,
                ..
            }
        ));
    }

    #[test]
    fn validate_rejects_anthropic_with_gpt() {
        let err = validate_provider_model(BuiltinProvider::Anthropic, Some("gpt-4o"))
            .expect_err("must err");
        assert!(matches!(
            err,
            ProviderModelMismatch::WrongProvider {
                detected: BuiltinProvider::Openai,
                ..
            }
        ));
    }

    #[test]
    fn validate_reasoning_effort_accepts_openai_allowlist() {
        for effort in SUPPORTED_OPENAI_REASONING_EFFORTS {
            assert!(
                validate_harness_reasoning_effort(StepHarness::Codex, Some(effort)).is_ok(),
                "{effort} should be accepted"
            );
        }
        assert!(validate_harness_reasoning_effort(StepHarness::Codex, None).is_ok());
    }

    #[test]
    fn normalize_reasoning_effort_trims_and_lowercases() {
        assert_eq!(
            normalize_harness_reasoning_effort(StepHarness::Codex, Some(" HIGH ")).unwrap(),
            Some("high".to_string())
        );
    }

    #[test]
    fn validate_reasoning_effort_rejects_unknown_values() {
        let err = validate_harness_reasoning_effort(StepHarness::Codex, Some("minimal"))
            .expect_err("unsupported effort must fail");
        assert!(matches!(
            err,
            ProviderReasoningEffortMismatch::UnsupportedEffort { .. }
        ));
        let msg = err.to_string();
        assert!(msg.contains("minimal"));
        assert!(msg.contains("low"));
        assert!(msg.contains("xhigh"));
    }

    #[test]
    fn validate_reasoning_effort_rejects_anthropic_provider() {
        let err = validate_harness_reasoning_effort(StepHarness::Claude, Some("high"))
            .expect_err("anthropic reasoning effort must fail");
        assert!(matches!(
            err,
            ProviderReasoningEffortMismatch::UnsupportedHarness {
                harness: StepHarness::Claude,
                ..
            }
        ));
        let msg = err.to_string();
        assert!(msg.contains("high"));
        assert!(msg.contains("codex"));
        assert!(msg.contains("claude"));
    }

    #[test]
    fn normalizes_personality_and_validates_output_verbosity() {
        assert_eq!(
            normalize_personality(Some(" Friendly ")).unwrap(),
            Some("friendly".into())
        );
        assert_eq!(
            normalize_harness_personality(StepHarness::Claude, Some("Explanatory")).unwrap(),
            Some("explanatory".into())
        );
        assert!(matches!(
            normalize_harness_personality(StepHarness::Codex, Some("explanatory")),
            Err(ProviderPersonalityMismatch::UnsupportedValue { .. })
        ));
        assert!(matches!(
            normalize_personality(Some("  ")),
            Err(ProviderPersonalityMismatch::Empty)
        ));
        assert_eq!(
            normalize_harness_verbosity(StepHarness::Codex, Some(OutputVerbosity::High)).unwrap(),
            Some(OutputVerbosity::High)
        );
        let error = normalize_harness_verbosity(StepHarness::Claude, Some(OutputVerbosity::Low))
            .expect_err("Claude must reject unsupported verbosity");
        assert!(error.to_string().contains("claude"));
        let error = normalize_harness_personality(StepHarness::Typesafe, Some("friendly"))
            .expect_err("TypeSafe must reject chat personality");
        assert!(error.to_string().contains("typesafe"));
    }

    #[test]
    fn validate_typesafe_agent_options_without_affecting_chat_providers() {
        assert!(
            validate_harness_agent_config(StepHarness::Claude, &AgentConfig::default()).is_ok()
        );
        assert!(validate_harness_agent_config(StepHarness::Codex, &AgentConfig::default()).is_ok());

        let config = AgentConfig::new()
            .with_provider(ProviderId::typesafe())
            .with_model(DEFAULT_TYPESAFE_MODEL);
        assert!(validate_harness_agent_config(StepHarness::Typesafe, &config).is_ok());

        let config = AgentConfig::new()
            .with_provider(ProviderId::typesafe())
            .with_tools(vec!["Bash".into()]);
        let error = validate_harness_agent_config(StepHarness::Typesafe, &config)
            .expect_err("TypeSafe must reject tools");
        assert_eq!(error.option, "tools");
        assert!(error.to_string().contains("typesafe"));
    }

    #[test]
    fn provider_serializes_lowercase() {
        let json = serde_json::to_string(&BuiltinProvider::Anthropic).unwrap();
        assert_eq!(json, "\"anthropic\"");
        let json = serde_json::to_string(&BuiltinProvider::Openai).unwrap();
        assert_eq!(json, "\"openai\"");
        let json = serde_json::to_string(&BuiltinProvider::Typesafe).unwrap();
        assert_eq!(json, "\"typesafe\"");
        let parsed: BuiltinProvider = serde_json::from_str("\"openai\"").unwrap();
        assert_eq!(parsed, BuiltinProvider::Openai);
    }
}
