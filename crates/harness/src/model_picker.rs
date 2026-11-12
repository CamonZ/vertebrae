//! Presentation policy for built-in local-chat menus only. Execution catalogs
//! remain intact; custom-provider lists must never pass through this policy.
use std::collections::BTreeMap;

use vertebrae_core::BuiltinProvider;
use vertebrae_harness_core::ModelCapability;

/// One concrete newest numeric version per ranked family, in intelligence order.
/// Codex's `default` sentinel retains its no-override semantics and metadata.
/// Equal versions prefer the undated ID, then the newest dated snapshot, then
/// lexical ID/metadata order. Aliases and unknown families are not menu rows.
pub fn curate_local_chat_models(
    provider: BuiltinProvider,
    models: Vec<ModelCapability>,
) -> Vec<ModelCapability> {
    let mut families = BTreeMap::new();
    let mut default = None;
    for model in models {
        if provider == BuiltinProvider::Openai && model.id == "default" {
            if default
                .as_ref()
                .is_none_or(|current| metadata_key(&model) < metadata_key(current))
            {
                default = Some(model);
            }
            continue;
        }
        let Some((rank, version, date)) = model_version(provider, &model.id) else {
            continue;
        };
        let key = (
            version,
            date.is_none(),
            date,
            model.id.clone(),
            metadata_key(&model),
        );
        let entry = families
            .entry(rank)
            .or_insert_with(|| (key.clone(), model.clone()));
        if key > entry.0 {
            *entry = (key, model);
        }
    }
    default
        .into_iter()
        .chain(families.into_values().map(|(_, model)| model))
        .collect()
}

fn metadata_key(model: &ModelCapability) -> String {
    // ModelCapability contains ordered sets, so this is deterministic even for
    // duplicate IDs with conflicting metadata. Never merge capabilities.
    serde_json::to_string(model).expect("model capability serialization")
}

fn model_version(provider: BuiltinProvider, id: &str) -> Option<(usize, Vec<u64>, Option<u64>)> {
    let normalized = id.to_ascii_lowercase();
    let mut parts = normalized.split('-').collect::<Vec<_>>();
    let date = parts
        .last()
        .filter(|part| part.len() == 8 && part.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|part| part.parse::<u64>().ok());
    if date.is_some() {
        parts.pop();
    }
    let (rank, version) = match provider {
        BuiltinProvider::Anthropic => {
            if parts.first()? != &"claude" {
                return None;
            }
            let family = parts.get(1)?;
            let rank = ["fable", "opus", "sonnet", "haiku"]
                .iter()
                .position(|candidate| candidate == family)?;
            (rank, parts.get(2..)?.join("."))
        }
        BuiltinProvider::Openai => {
            if parts.first()? != &"gpt" {
                return None;
            }
            let rank = ["astra", "sol", "terra", "luna"]
                .iter()
                .position(|family| Some(family) == parts.last())?;
            (rank, parts.get(1..parts.len().checked_sub(1)?)?.join("."))
        }
        _ => return None,
    };
    let mut version = version
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    while version.len() > 1 && version.last() == Some(&0) {
        version.pop();
    }
    Some((rank, version, date))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use vertebrae_harness_core::SpeedTier;

    fn model(id: &str) -> ModelCapability {
        ModelCapability {
            id: id.into(),
            label: id.into(),
            reasoning_efforts: BTreeSet::from(["high".into()]),
            supported_speed_tiers: BTreeSet::from([SpeedTier::Fast]),
            supports_personality: Some(false),
        }
    }
    fn ids(provider: BuiltinProvider, input: &[&str]) -> Vec<String> {
        curate_local_chat_models(provider, input.iter().map(|id| model(id)).collect())
            .into_iter()
            .map(|model| model.id)
            .collect()
    }
    #[test]
    fn anthropic_order_is_family_first_with_numeric_versions_and_concrete_ids() {
        let input = [
            "claude-haiku-5-5",
            "opus",
            "claude-opus-5-9",
            "claude-sonnet-5-5",
            "claude-fable-5-2-20261112",
            "claude-fable-5-2",
            "claude-opus-5-10",
            "claude-opus-5-10",
            "claude-unknown-99",
            "fable",
        ];
        let expected = [
            "claude-fable-5-2",
            "claude-opus-5-10",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
        ];
        assert_eq!(ids(BuiltinProvider::Anthropic, &input), expected);
        assert_eq!(
            ids(
                BuiltinProvider::Anthropic,
                &input.into_iter().rev().collect::<Vec<_>>()
            ),
            expected
        );
    }
    #[test]
    fn openai_preserves_opaque_ids_metadata_and_default() {
        let input = [
            "gpt-6.1-terra",
            "gpt-6-sol",
            "gpt-6.1-sol",
            "gpt-6-luna",
            "gpt-6-astra",
            "gpt-5.6-sol",
            "default",
            "gpt-unranked",
            "sol",
        ];
        assert_eq!(
            ids(BuiltinProvider::Openai, &input),
            [
                "default",
                "gpt-6-astra",
                "gpt-6.1-sol",
                "gpt-6.1-terra",
                "gpt-6-luna"
            ]
        );
        let selected = model("gpt-6.10-sol");
        assert_eq!(
            curate_local_chat_models(
                BuiltinProvider::Openai,
                vec![model("gpt-6.9-sol"), selected.clone()]
            ),
            vec![selected]
        );
    }
    #[test]
    fn missing_empty_alias_only_and_unknown_families_stay_absent() {
        assert!(ids(BuiltinProvider::Anthropic, &[]).is_empty());
        assert!(ids(BuiltinProvider::Anthropic, &["fable", "claude-mythos-5-2"]).is_empty());
        assert_eq!(
            ids(BuiltinProvider::Openai, &["gpt-6-luna"]),
            ["gpt-6-luna"]
        );
        assert_eq!(
            ids(BuiltinProvider::Openai, &["default", "gpt-5.5"]),
            ["default"]
        );
    }
    #[test]
    fn snapshot_ties_and_duplicate_metadata_are_input_order_independent() {
        let input = ["gpt-6-sol-20261111", "gpt-6-sol-20261112", "gpt-6.0-sol"];
        assert_eq!(ids(BuiltinProvider::Openai, &input), ["gpt-6.0-sol"]);
        let mut duplicate = model("gpt-6-sol");
        duplicate.reasoning_efforts.clear();
        let a = vec![model("gpt-6-sol"), duplicate];
        assert_eq!(
            curate_local_chat_models(BuiltinProvider::Openai, a.clone()),
            curate_local_chat_models(BuiltinProvider::Openai, a.into_iter().rev().collect())
        );
    }
}

#[cfg(all(test, unix))]
mod discovery_tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    use vertebrae_harness_codex::{CodexProviderConfig, CodexRuntime};
    use vertebrae_harness_core::{HarnessRuntime, SpeedTier};

    #[tokio::test]
    async fn bundled_fallback_is_curated_without_restricting_raw_execution_catalog() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("codex");
        fs::write(&executable, r#"#!/bin/sh
if [ "$1" != debug ]; then exit 1; fi
cat <<'JSON'
{"models":[
 {"slug":"gpt-6.9-sol","display_name":"Older Sol","visibility":"list","priority":0},
 {"slug":"gpt-6.10-sol","display_name":"Newer Sol","visibility":"list","priority":99,"supports_personality":false,"supported_reasoning_levels":[{"effort":"high"}],"additional_speed_tiers":["fast"]},
 {"slug":"gpt-99-sol","display_name":"Hidden Sol","visibility":"hide","priority":0},
 {"slug":"gpt-6-astra","display_name":"Astra 6","visibility":"list","priority":2},
 {"slug":"gpt-5.5","display_name":"Unranked default","visibility":"list","priority":1}
]}
JSON
"#).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let capabilities = CodexRuntime::new(CodexProviderConfig {
            executable: Some(executable),
            ..Default::default()
        })
        .capabilities()
        .await
        .unwrap();
        assert!(capabilities.available);
        assert!(
            capabilities
                .models
                .iter()
                .any(|model| model.id == "gpt-5.5")
        );
        let curated = curate_local_chat_models(BuiltinProvider::Openai, capabilities.models);
        assert_eq!(
            curated
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "gpt-6-astra", "gpt-6.10-sol"]
        );
        assert_eq!(curated[2].supports_personality, Some(false));
        assert!(curated[2].reasoning_efforts.contains("high"));
        assert!(curated[2].supported_speed_tiers.contains(&SpeedTier::Fast));
    }
}
