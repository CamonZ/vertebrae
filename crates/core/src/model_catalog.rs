//! Model catalog: maps model names to their built-in execution provider.
//!
//! This is a small, conservative classifier used by Vertebrae to validate
//! `--model` / `--provider` combinations on `vtb step add` and
//! `vtb step update`. It is intentionally not an exhaustive list of every
//! model name a vendor publishes -- vendor catalogs change frequently. We only
//! recognize the aliases and prefixes Vertebrae intentionally supports today,
//! and we reject everything else with a clear error so users either update the
//! catalog or fall back to the `--agent-config` JSON escape hatch.
//!
//! MVP providers:
//! - `anthropic` (Claude Code): `claude-*` prefix and the bare aliases
//!   `opus`, `sonnet`, `haiku`.
//! - `openai` (Codex / GPT): `gpt-*` prefix, `o*` reasoning models
//!   (e.g. `o1`, `o3`, `o4-mini`), and `codex-*`.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Built-in execution providers recognized by Vertebrae.
///
/// `Provider` is the MVP set; user-owned harness profiles are out of scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Openai,
}

impl Provider {
    /// String form used on the CLI and in serialized agent_config JSON.
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Openai => "openai",
        }
    }

    /// Parse a provider name (case-insensitive). Accepts the canonical names
    /// (`anthropic`, `openai`) plus a couple of common aliases.
    pub fn parse(input: &str) -> Result<Self, String> {
        let normalized = input.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "anthropic" | "claude" => Ok(Provider::Anthropic),
            "openai" | "codex" => Ok(Provider::Openai),
            other => Err(format!(
                "Unknown provider '{}'. Supported providers: anthropic, openai",
                other
            )),
        }
    }
}

impl fmt::Display for Provider {
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
pub fn classify_model(model: &str) -> Option<Provider> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.to_ascii_lowercase();

    // Anthropic: bare aliases and `claude-*` prefix.
    if matches!(normalized.as_str(), "opus" | "sonnet" | "haiku")
        || normalized.starts_with("claude-")
        || normalized == "claude"
    {
        return Some(Provider::Anthropic);
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
        return Some(Provider::Openai);
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

/// Validate that a `(provider, model)` pair is internally consistent.
///
/// Rules:
/// - If the model is recognized and maps to a different provider, reject with
///   an actionable error.
/// - If the model is not recognized at all, reject with an error pointing to
///   the `--agent-config` JSON escape hatch.
/// - If the model is `None`, any provider is fine -- the provider can be
///   stored on the agent_config without a model.
pub fn validate_provider_model(
    provider: Provider,
    model: Option<&str>,
) -> Result<(), ProviderModelMismatch> {
    let Some(model) = model else {
        return Ok(());
    };
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    match classify_model(trimmed) {
        Some(detected) if detected == provider => Ok(()),
        Some(detected) => Err(ProviderModelMismatch::WrongProvider {
            requested: provider,
            detected,
            model: trimmed.to_string(),
        }),
        None => Err(ProviderModelMismatch::UnknownModel {
            requested: provider,
            model: trimmed.to_string(),
        }),
    }
}

/// Reasons a `(provider, model)` pair can fail validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderModelMismatch {
    /// The model is recognized but belongs to a different provider.
    WrongProvider {
        requested: Provider,
        detected: Provider,
        model: String,
    },
    /// The model is not recognized by the built-in catalog at all.
    UnknownModel { requested: Provider, model: String },
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
                 If this is a valid {} model, pass the full agent config JSON via --agent-config \
                 (e.g. --agent-config '{{\"provider\":\"{}\",\"model\":\"{}\"}}') as the escape hatch.",
                model, requested, requested, requested, model
            ),
        }
    }
}

impl std::error::Error for ProviderModelMismatch {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_anthropic_aliases() {
        assert_eq!(classify_model("opus"), Some(Provider::Anthropic));
        assert_eq!(classify_model("sonnet"), Some(Provider::Anthropic));
        assert_eq!(classify_model("haiku"), Some(Provider::Anthropic));
        assert_eq!(classify_model("Opus"), Some(Provider::Anthropic));
    }

    #[test]
    fn classify_anthropic_prefixes() {
        assert_eq!(classify_model("claude-opus-4-5"), Some(Provider::Anthropic));
        assert_eq!(
            classify_model("claude-3-5-sonnet"),
            Some(Provider::Anthropic)
        );
        assert_eq!(
            classify_model("claude-haiku-4-5"),
            Some(Provider::Anthropic)
        );
        assert_eq!(classify_model("claude"), Some(Provider::Anthropic));
    }

    #[test]
    fn classify_openai_gpt() {
        assert_eq!(classify_model("gpt-4"), Some(Provider::Openai));
        assert_eq!(classify_model("gpt-4o"), Some(Provider::Openai));
        assert_eq!(classify_model("gpt-4o-mini"), Some(Provider::Openai));
        assert_eq!(classify_model("GPT-5"), Some(Provider::Openai));
    }

    #[test]
    fn classify_openai_reasoning() {
        assert_eq!(classify_model("o1"), Some(Provider::Openai));
        assert_eq!(classify_model("o1-mini"), Some(Provider::Openai));
        assert_eq!(classify_model("o3"), Some(Provider::Openai));
        assert_eq!(classify_model("o3-mini"), Some(Provider::Openai));
        assert_eq!(classify_model("o4-mini"), Some(Provider::Openai));
    }

    #[test]
    fn classify_openai_codex() {
        assert_eq!(classify_model("codex-mini-latest"), Some(Provider::Openai));
        assert_eq!(classify_model("codex"), Some(Provider::Openai));
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
        assert_eq!(classify_model("opus"), Some(Provider::Anthropic));
        // 'other' starts with 'o' but second char isn't a digit -> not openai.
        assert_eq!(classify_model("other-model"), None);
    }

    #[test]
    fn provider_parse_canonical() {
        assert_eq!(Provider::parse("anthropic"), Ok(Provider::Anthropic));
        assert_eq!(Provider::parse("openai"), Ok(Provider::Openai));
        assert_eq!(Provider::parse("Anthropic"), Ok(Provider::Anthropic));
        assert_eq!(Provider::parse("OPENAI"), Ok(Provider::Openai));
    }

    #[test]
    fn provider_parse_aliases() {
        assert_eq!(Provider::parse("claude"), Ok(Provider::Anthropic));
        assert_eq!(Provider::parse("codex"), Ok(Provider::Openai));
    }

    #[test]
    fn provider_parse_unknown() {
        let err = Provider::parse("bedrock").unwrap_err();
        assert!(err.contains("bedrock"));
        assert!(err.contains("anthropic"));
        assert!(err.contains("openai"));
    }

    #[test]
    fn validate_accepts_matching_pair() {
        assert!(validate_provider_model(Provider::Anthropic, Some("opus")).is_ok());
        assert!(validate_provider_model(Provider::Anthropic, Some("claude-opus-4-5")).is_ok());
        assert!(validate_provider_model(Provider::Openai, Some("gpt-4o")).is_ok());
        assert!(validate_provider_model(Provider::Openai, Some("o3-mini")).is_ok());
    }

    #[test]
    fn validate_accepts_no_model() {
        assert!(validate_provider_model(Provider::Openai, None).is_ok());
        assert!(validate_provider_model(Provider::Anthropic, Some("")).is_ok());
    }

    #[test]
    fn validate_rejects_wrong_provider() {
        let err =
            validate_provider_model(Provider::Openai, Some("claude-opus")).expect_err("must err");
        match err {
            ProviderModelMismatch::WrongProvider {
                requested,
                detected,
                ref model,
            } => {
                assert_eq!(requested, Provider::Openai);
                assert_eq!(detected, Provider::Anthropic);
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
        let err = validate_provider_model(Provider::Openai, Some("kimi2.6")).expect_err("must err");
        match err {
            ProviderModelMismatch::UnknownModel {
                requested,
                ref model,
            } => {
                assert_eq!(requested, Provider::Openai);
                assert_eq!(model, "kimi2.6");
            }
            other => panic!("expected UnknownModel, got {:?}", other),
        }
        let msg = format!("{}", err);
        assert!(msg.contains("kimi2.6"));
        assert!(msg.contains("--agent-config"));
    }

    #[test]
    fn validate_rejects_anthropic_with_gpt() {
        let err =
            validate_provider_model(Provider::Anthropic, Some("gpt-4o")).expect_err("must err");
        assert!(matches!(
            err,
            ProviderModelMismatch::WrongProvider {
                detected: Provider::Openai,
                ..
            }
        ));
    }

    #[test]
    fn provider_serializes_lowercase() {
        let json = serde_json::to_string(&Provider::Anthropic).unwrap();
        assert_eq!(json, "\"anthropic\"");
        let json = serde_json::to_string(&Provider::Openai).unwrap();
        assert_eq!(json, "\"openai\"");
        let parsed: Provider = serde_json::from_str("\"openai\"").unwrap();
        assert_eq!(parsed, Provider::Openai);
    }
}
