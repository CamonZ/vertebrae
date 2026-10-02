//! Production `vtb::*` host modules for Rhai execute scripts.
//!
//! Every function runs on the script's blocking worker thread and reaches
//! Sacrum through [`HostContext::call`], which supplies the execution's
//! project and races the attempt's cancellation. Scripts never pass project
//! IDs; anything outside the execution's project behaves as absent.

mod tasks;

use rhai::{Dynamic, Engine, Module};

use crate::script_worker::{HostContext, HostError};

pub(crate) fn register(engine: &mut Engine, host: &HostContext) {
    engine.register_static_module("vtb::tasks", tasks::module(host).into());
}

/// Register a one-argument host function whose errors carry its qualified
/// name. Arguments arrive as `Dynamic` so wrong types raise `invalid` instead
/// of Rhai's function-not-found error.
fn set_host_fn(
    module: &mut Module,
    host: &HostContext,
    namespace: &str,
    name: &str,
    function: fn(&HostContext, Dynamic) -> Result<Dynamic, HostError>,
) {
    let host = host.clone();
    let qualified = format!("{namespace}::{name}");
    module.set_native_fn(name, move |argument: Dynamic| {
        function(&host, argument).map_err(|error| error.in_function(qualified.as_str()).into())
    });
}

/// A full hyphenated UUID, normalized to lowercase. Short IDs are rejected.
fn uuid_argument(value: Dynamic, what: &str) -> Result<String, HostError> {
    let text = string_argument(value, what)?;
    let parsed = (text.len() == 36)
        .then(|| uuid::Uuid::try_parse(&text).ok())
        .flatten()
        .ok_or_else(|| HostError::invalid(format!("{what} must be a full UUID, got {text:?}")))?;
    Ok(parsed.hyphenated().to_string())
}

fn string_argument(value: Dynamic, what: &str) -> Result<String, HostError> {
    let type_name = value.type_name();
    value
        .into_immutable_string()
        .map(|text| text.to_string())
        .map_err(|_| HostError::invalid(format!("{what} must be a string, got {type_name}")))
}

fn bool_argument(value: Dynamic, what: &str) -> Result<bool, HostError> {
    let type_name = value.type_name();
    value
        .as_bool()
        .map_err(|_| HostError::invalid(format!("{what} must be a boolean, got {type_name}")))
}

fn optional_string(value: Option<&str>) -> Dynamic {
    value.map_or(Dynamic::UNIT, Into::into)
}
