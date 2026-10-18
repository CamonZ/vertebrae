use std::collections::BTreeSet;

use serde_json::{Value, json};
use vertebrae_harness_core::{HarnessError, ModelCapability};

pub const MAX_BYTES: usize = 1024 * 1024;

pub struct ModelCatalog {
    pub models: Vec<ModelCapability>,
    pub default_model: String,
}

pub fn parse_catalog(value: &Value) -> Result<ModelCatalog, HarnessError> {
    let config = value.pointer("/config").ok_or_else(invalid)?;
    let default_model = string_at(config, "/defaultModelAlias")?.to_owned();
    let raw_models = config
        .pointer("/models")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let mut models = Vec::new();
    for model in raw_models {
        let alias = string_at(model, "/alias")?;
        let label = model
            .pointer("/displayName")
            .and_then(Value::as_str)
            .unwrap_or(alias);
        let mut reasoning_efforts = BTreeSet::new();
        if let Some(levels) = model.pointer("/thinkingLevels").and_then(Value::as_array) {
            for level in levels {
                reasoning_efforts.insert(level.as_str().ok_or_else(invalid)?.to_string());
            }
        }
        models.push(ModelCapability {
            id: alias.to_owned(),
            label: label.to_owned(),
            reasoning_efforts,
            supported_speed_tiers: BTreeSet::new(),
            supports_personality: Some(false),
        });
    }
    if models.is_empty() {
        return Err(invalid());
    }
    Ok(ModelCatalog {
        models,
        default_model,
    })
}

pub fn model_name<'a>(catalog: &'a Value, alias: &str) -> Result<&'a str, HarnessError> {
    catalog
        .pointer("/config/models")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?
        .iter()
        .find(|model| {
            model
                .pointer("/alias")
                .and_then(Value::as_str)
                .is_some_and(|candidate| candidate == alias)
        })
        .and_then(|model| model.pointer("/name").and_then(Value::as_str))
        .ok_or_else(|| {
            HarnessError::InvalidRequest(format!(
                "model '{alias}' is not available from the installed Mistral Vibe server"
            ))
        })
}

pub fn string_at<'a>(value: &'a Value, pointer: &str) -> Result<&'a str, HarnessError> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or_else(invalid)
}

pub fn invalid<T>() -> T
where
    HarnessError: Into<T>,
{
    HarnessError::Operation("invalid Mistral Vibe protocol response".into()).into()
}

pub fn apply_patch(entry: &mut Value, patches: &Value) -> Result<(), HarnessError> {
    let patches = patches
        .as_array()
        .ok_or_else(|| HarnessError::Operation("history patch must be an array".into()))?;
    for operation in patches {
        let mut operation = operation.clone();
        if operation["op"] == "append" {
            let path = string_at(&operation, "/path")?;
            let previous = entry.pointer(path).and_then(Value::as_str).ok_or_else(|| {
                HarnessError::Operation("history append target is not text".into())
            })?;
            let suffix = string_at(&operation, "/value")?;
            let combined = format!("{previous}{suffix}");
            if combined.len() > MAX_BYTES {
                return Err(HarnessError::Operation(
                    "Mistral Vibe response exceeds 1 MiB".into(),
                ));
            }
            operation["op"] = json!("replace");
            operation["value"] = json!(combined);
        }
        let patch: json_patch::Patch = serde_json::from_value(json!([operation]))
            .map_err(|_| HarnessError::Operation("invalid history patch".into()))?;
        json_patch::patch(entry, &patch)
            .map_err(|_| HarnessError::Operation("cannot apply history patch".into()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_dynamic_model_catalog() {
        let catalog = parse_catalog(&json!({
            "config": {
                "defaultModelAlias": "medium",
                "models": [
                    {
                        "alias": "medium",
                        "name": "mistral-medium-latest",
                        "displayName": "Mistral Medium",
                        "thinkingLevels": ["off", "high"]
                    },
                    {"alias": "large", "name": "mistral-large-latest"}
                ]
            }
        }))
        .unwrap();

        assert_eq!(catalog.default_model, "medium");
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[0].label, "Mistral Medium");
        assert!(catalog.models[0].reasoning_efforts.contains("high"));
        let catalog_value = json!({
            "config": {"models": [{"alias": "medium", "name": "mistral-medium-latest"}]}
        });
        assert!(model_name(&catalog_value, "large").is_err());
    }

    #[test]
    fn rejects_unknown_dynamic_model() {
        let value = json!({
            "config": {
                "defaultModelAlias": "medium",
                "models": [{"alias": "medium", "name": "mistral-medium-latest"}]
            }
        });
        let error = model_name(&value, "large").unwrap_err();
        assert!(error.to_string().contains("large"));
    }
}
